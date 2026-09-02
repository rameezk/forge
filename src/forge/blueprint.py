import importlib.resources
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKError,
    ResultMessage,
    TextBlock,
    query,
)

BLUEPRINT_MODEL = "claude-opus-4-8"
BLUEPRINT_EFFORT = "high"

BLUEPRINT_DISALLOWED_TOOLS = (
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "ExitPlanMode",
)

BLUEPRINT_ERROR_MARKER = "BLUEPRINT_ERROR:"

PLAN_START_MARKER = "<<<BLUEPRINT_PLAN>>>"
PLAN_END_MARKER = "<<</BLUEPRINT_PLAN>>>"

H1_HEADING_MARKER = "# "

REQUIRED_PLAN_HEADINGS = (
    H1_HEADING_MARKER,
    "## Summary",
    "## Implementation steps",
    "## Testing",
)

MAX_PLAN_ATTEMPTS = 2

NON_SUBSCRIPTION_AUTH_ENV_VARS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
)


class BlueprintError(Exception):
    pass


class _PlanFormatError(BlueprintError):
    def __init__(self, message: str, missing: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.missing = missing


_PROMPT_RESOURCE_NAME = "blueprint_prompt.md"


def _load_planning_prompt() -> str:
    try:
        text = (
            importlib.resources.files("forge")
            .joinpath(_PROMPT_RESOURCE_NAME)
            .read_text(encoding="utf-8")
        )
    except OSError as error:
        raise BlueprintError(
            f"{_PROMPT_RESOURCE_NAME} could not be loaded: {error}"
        ) from error

    stripped = text.strip()
    if not stripped:
        raise BlueprintError(f"{_PROMPT_RESOURCE_NAME} is missing or empty")
    return stripped


BLUEPRINT_PLANNING_PROMPT = _load_planning_prompt()


def _unwrap_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return text

    lines = stripped.split("\n")
    if len(lines) < 2 or lines[-1].strip() != "```":
        return text

    return "\n".join(lines[1:-1])


def _extract_plan_block(text: str) -> str | None:
    start_index = text.find(PLAN_START_MARKER)
    if start_index == -1:
        return None

    after_start = start_index + len(PLAN_START_MARKER)
    end_index = text.rfind(PLAN_END_MARKER)
    if end_index == -1 or end_index < after_start:
        return text[after_start:].strip()

    return text[after_start:end_index].strip()


def _raise_if_error_sentinel(text: str) -> None:
    first_non_empty = next((line for line in text.split("\n") if line.strip()), "")
    if first_non_empty.strip().startswith(BLUEPRINT_ERROR_MARKER):
        reason = first_non_empty.strip()[len(BLUEPRINT_ERROR_MARKER) :].strip()
        raise BlueprintError(
            reason or "blueprint agent reported it cannot plan this request"
        )


def _classify_plan(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        raise _PlanFormatError("blueprint run produced no plan output")

    _raise_if_error_sentinel(stripped)

    block = _extract_plan_block(stripped)
    working = stripped
    if block is not None:
        _raise_if_error_sentinel(block)
        working = block

    if not working:
        if block is not None:
            raise _PlanFormatError(
                "blueprint run produced an empty plan between the markers"
            )
        raise _PlanFormatError("blueprint run produced no plan output")

    unwrapped = _unwrap_fence(working)
    normalized = [line.strip().lower() for line in unwrapped.split("\n")]
    missing = tuple(
        heading
        for heading in REQUIRED_PLAN_HEADINGS
        if not _heading_present(heading, normalized)
    )
    if missing:
        labels = ", ".join(_heading_label(heading) for heading in missing)
        raise _PlanFormatError(
            "plan is missing required heading(s): " + labels,
            missing=missing,
        )

    return unwrapped


def _heading_label(heading: str) -> str:
    return "H1 title" if heading == H1_HEADING_MARKER else heading


def _heading_present(heading: str, normalized_lines: list[str]) -> bool:
    if heading == H1_HEADING_MARKER:
        return any(line.startswith(H1_HEADING_MARKER) for line in normalized_lines)
    return heading.lower() in normalized_lines


def _build_options(
    cwd: str | Path | None, resume: str | None = None
) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        skills=[],
        permission_mode="plan",
        model=BLUEPRINT_MODEL,
        effort=BLUEPRINT_EFFORT,
        cwd=cwd,
        system_prompt=BLUEPRINT_PLANNING_PROMPT,
        disallowed_tools=list(BLUEPRINT_DISALLOWED_TOOLS),
        env={name: "" for name in NON_SUBSCRIPTION_AUTH_ENV_VARS},
        resume=resume,
    )


def _correction_prompt_heading(heading: str) -> str:
    return "a single `# ` title line" if heading == H1_HEADING_MARKER else heading


def _correction_prompt(missing: tuple[str, ...]) -> str:
    named = (
        ", ".join(_correction_prompt_heading(heading) for heading in missing)
        if missing
        else "the required headings"
    )
    return (
        f"That response was not a usable plan: it is missing {named}. Send a "
        "corrected version. Your entire final message MUST be the finished "
        "plan as raw markdown: no code fence, no preamble, no summary, "
        f"nothing before or after. It MUST begin with the exact line "
        f"{PLAN_START_MARKER}, immediately followed by a single `# ` title "
        f"line and the rest of the plan, and MUST end with the exact line "
        f"{PLAN_END_MARKER}."
    )


async def _run_turn(
    prompt: str, cwd: str | Path | None, resume: str | None
) -> tuple[str, str | None]:
    accumulated: list[str] = []
    result_text: str | None = None
    session_id: str | None = None

    try:
        async for message in query(
            prompt=prompt, options=_build_options(cwd, resume=resume)
        ):
            if isinstance(message, AssistantMessage):
                accumulated.extend(
                    block.text
                    for block in message.content
                    if isinstance(block, TextBlock)
                )
            elif isinstance(message, ResultMessage):
                session_id = message.session_id
                if message.is_error:
                    raise BlueprintError(
                        f"blueprint run failed: {message.result or 'unknown error'}"
                    )
                result_text = message.result
    except ClaudeSDKError as error:
        raise BlueprintError(f"blueprint run failed: {error}") from error

    plan = result_text if result_text else "".join(accumulated)
    return plan, session_id


async def run_blueprint(request: str, cwd: str | Path | None = None) -> str:
    if not request.strip():
        raise BlueprintError("request must not be empty or whitespace-only")

    prompt = request
    resume: str | None = None

    for attempt in range(1, MAX_PLAN_ATTEMPTS + 1):
        plan, session_id = await _run_turn(prompt, cwd, resume)
        try:
            return _classify_plan(plan)
        except _PlanFormatError as error:
            if session_id is None:
                raise BlueprintError(
                    f"blueprint run produced no session id to resume: {error}"
                ) from error
            if attempt == MAX_PLAN_ATTEMPTS:
                raise BlueprintError(
                    f"blueprint run exhausted {MAX_PLAN_ATTEMPTS} attempt(s): {error}"
                ) from error
            resume = session_id
            prompt = _correction_prompt(error.missing)

    raise BlueprintError("blueprint run exhausted all attempts")
