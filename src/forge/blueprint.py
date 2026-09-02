from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKError,
    ResultMessage,
    TextBlock,
    query,
)

BLUEPRINT_SKILL = "blueprint"
BLUEPRINT_MODEL = "claude-opus-4-8"
BLUEPRINT_EFFORT = "high"

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


def _build_options(cwd: str | Path | None) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        skills=[BLUEPRINT_SKILL],
        permission_mode="plan",
        model=BLUEPRINT_MODEL,
        effort=BLUEPRINT_EFFORT,
        cwd=cwd,
        env={name: "" for name in NON_SUBSCRIPTION_AUTH_ENV_VARS},
    )


async def run_blueprint(request: str, cwd: str | Path | None = None) -> str:
    if not request.strip():
        raise BlueprintError("request must not be empty or whitespace-only")

    accumulated: list[str] = []
    result_text: str | None = None

    try:
        async for message in query(prompt=request, options=_build_options(cwd)):
            if isinstance(message, AssistantMessage):
                accumulated.extend(
                    block.text
                    for block in message.content
                    if isinstance(block, TextBlock)
                )
            elif isinstance(message, ResultMessage):
                if message.is_error:
                    raise BlueprintError(
                        f"blueprint run failed: {message.result or 'unknown error'}"
                    )
                result_text = message.result
    except ClaudeSDKError as error:
        raise BlueprintError(f"blueprint run failed: {error}") from error

    plan = result_text if result_text else "".join(accumulated)
    if not plan.strip():
        raise BlueprintError("blueprint run produced no plan output")
    return plan
