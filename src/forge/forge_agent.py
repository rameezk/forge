import importlib.resources
import re
from dataclasses import dataclass
from pathlib import Path

from claude_agent_sdk import (
    AgentDefinition,
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKError,
    ResultMessage,
    TextBlock,
    query,
)

from forge.blueprint import NON_SUBSCRIPTION_AUTH_ENV_VARS

FORGE_MODEL = "claude-sonnet-5"
FORGE_EFFORT = "high"
FORGE_MAX_BUDGET_USD = 4.0

FORGE_ERROR_MARKER = "FORGE_ERROR:"

PR_URL_PATTERN = re.compile(
    r"^https://github\.com/"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/"
    r"[A-Za-z0-9._-]+/pull/\d+$"
)

_PROMPT_RESOURCE_NAME = "forge_agent_prompt.md"

_PLUGIN_NAME = "forge-pipeline"
_PLUGIN_SKILL_NAMES = (
    "forge",
    "tdd",
    "code-quality",
    "git-branching",
    "git-committing",
    "git-pr",
)
FORGE_SKILLS = tuple(f"{_PLUGIN_NAME}:{name}" for name in _PLUGIN_SKILL_NAMES)

FORGE_REVIEWER_AGENT_NAMES = ("code-reviewer", "security-reviewer")


class ForgeError(Exception):
    pass


@dataclass(frozen=True)
class ForgeResult:
    pr_url: str
    cost_usd: float | None


def _load_prompt() -> str:
    try:
        text = (
            importlib.resources.files("forge")
            .joinpath(_PROMPT_RESOURCE_NAME)
            .read_text(encoding="utf-8")
        )
    except OSError as error:
        raise ForgeError(
            f"{_PROMPT_RESOURCE_NAME} could not be loaded: {error}"
        ) from error

    stripped = text.strip()
    if not stripped:
        raise ForgeError(f"{_PROMPT_RESOURCE_NAME} is missing or empty")
    return stripped


FORGE_PROMPT = _load_prompt()


def _parse_agent_markdown(resource_name: str, text: str) -> AgentDefinition:
    if not text.startswith("---"):
        raise ForgeError(f"{resource_name} is missing YAML frontmatter")

    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ForgeError(f"{resource_name} has malformed frontmatter")

    frontmatter_block, body = parts[1], parts[2]
    frontmatter: dict[str, str] = {}
    for line in frontmatter_block.strip().splitlines():
        if not line.strip():
            continue
        key, separator, value = line.partition(":")
        if not separator:
            raise ForgeError(f"{resource_name} has malformed frontmatter")
        frontmatter[key.strip()] = value.strip()

    description = frontmatter.get("description")
    if not description:
        raise ForgeError(f"{resource_name} is missing a description")

    prompt = body.strip()
    if not prompt:
        raise ForgeError(f"{resource_name} has an empty prompt body")

    tools = frontmatter.get("tools")
    return AgentDefinition(
        description=description,
        prompt=prompt,
        tools=[tool.strip() for tool in tools.split(",") if tool.strip()]
        if tools
        else None,
        model=frontmatter.get("model"),
    )


def _load_agent_definition(name: str) -> AgentDefinition:
    resource_name = f"plugin/agents/{name}.md"
    try:
        text = (
            importlib.resources.files("forge")
            .joinpath("plugin", "agents", f"{name}.md")
            .read_text(encoding="utf-8")
        )
    except OSError as error:
        raise ForgeError(f"{resource_name} could not be loaded: {error}") from error

    stripped = text.strip()
    if not stripped:
        raise ForgeError(f"{resource_name} is missing or empty")
    return _parse_agent_markdown(resource_name, stripped)


def _load_reviewer_agents() -> dict[str, AgentDefinition]:
    return {name: _load_agent_definition(name) for name in FORGE_REVIEWER_AGENT_NAMES}


FORGE_REVIEWER_AGENTS = _load_reviewer_agents()


def _classify_output(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        raise ForgeError("forge run produced no output")

    first_non_empty = next((line for line in stripped.split("\n") if line.strip()), "")
    if first_non_empty.strip().startswith(FORGE_ERROR_MARKER):
        reason = first_non_empty.strip()[len(FORGE_ERROR_MARKER) :].strip()
        raise ForgeError(
            reason or "forge agent reported it could not deliver a pull request"
        )

    if PR_URL_PATTERN.match(stripped):
        return stripped

    clipped = stripped[:200]
    raise ForgeError(f"forge did not produce a pull request: {clipped}")


def _build_options(cwd: str | Path | None, plugin_path: Path) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model=FORGE_MODEL,
        effort=FORGE_EFFORT,
        max_budget_usd=FORGE_MAX_BUDGET_USD,
        permission_mode="bypassPermissions",
        cwd=cwd,
        system_prompt=FORGE_PROMPT,
        env={name: "" for name in NON_SUBSCRIPTION_AUTH_ENV_VARS},
        skills=list(FORGE_SKILLS),
        agents=FORGE_REVIEWER_AGENTS,
        plugins=[{"type": "local", "path": str(plugin_path)}],
    )


async def run_forge(request: str, cwd: str | Path | None = None) -> ForgeResult:
    if not request.strip():
        raise ForgeError("request must not be empty or whitespace-only")

    accumulated: list[str] = []
    result_message: ResultMessage | None = None

    try:
        with importlib.resources.as_file(
            importlib.resources.files("forge").joinpath("plugin")
        ) as plugin_path:
            options = _build_options(cwd, plugin_path)
            async for message in query(prompt=request, options=options):
                if isinstance(message, AssistantMessage):
                    accumulated.extend(
                        block.text
                        for block in message.content
                        if isinstance(block, TextBlock)
                    )
                elif isinstance(message, ResultMessage):
                    result_message = message
    except ClaudeSDKError as error:
        raise ForgeError(f"forge run failed: {error}") from error

    if result_message is not None and result_message.is_error:
        if result_message.subtype == "error_max_budget_usd":
            raise ForgeError(f"forge exceeded its {FORGE_MAX_BUDGET_USD} USD budget")
        raise ForgeError(
            f"forge run failed: {result_message.result or 'unknown error'}"
        )

    text = (
        result_message.result
        if result_message and result_message.result
        else "".join(accumulated)
    )
    pr_url = _classify_output(text)
    cost_usd = result_message.total_cost_usd if result_message else None
    return ForgeResult(pr_url=pr_url, cost_usd=cost_usd)
