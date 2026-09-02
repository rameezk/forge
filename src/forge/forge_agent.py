import importlib.resources
import re
from dataclasses import dataclass
from pathlib import Path

from claude_agent_sdk import (
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


def _build_options(cwd: str | Path | None) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model=FORGE_MODEL,
        effort=FORGE_EFFORT,
        max_budget_usd=FORGE_MAX_BUDGET_USD,
        permission_mode="bypassPermissions",
        cwd=cwd,
        system_prompt=FORGE_PROMPT,
        env={name: "" for name in NON_SUBSCRIPTION_AUTH_ENV_VARS},
    )


async def run_forge(request: str, cwd: str | Path | None = None) -> ForgeResult:
    if not request.strip():
        raise ForgeError("request must not be empty or whitespace-only")

    accumulated: list[str] = []
    result_message: ResultMessage | None = None

    try:
        async for message in query(prompt=request, options=_build_options(cwd)):
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
