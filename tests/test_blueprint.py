from unittest.mock import patch

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    CLINotFoundError,
    ProcessError,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from forge.blueprint import (
    BLUEPRINT_MODEL,
    NON_SUBSCRIPTION_AUTH_ENV_VARS,
    BlueprintError,
    run_blueprint,
)

pytestmark = pytest.mark.asyncio


def _assistant(*texts: str) -> AssistantMessage:
    return AssistantMessage(
        content=[TextBlock(text=text) for text in texts],
        model=BLUEPRINT_MODEL,
    )


def _result(result: str | None = "ok", is_error: bool = False) -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id="s",
        result=result,
    )


def _stream(*messages):
    async def _gen(**_kwargs):
        for message in messages:
            yield message

    return _gen


def _raising(error: Exception):
    async def _gen(**_kwargs):
        raise error
        yield  # pragma: no cover

    return _gen


async def given_a_plan_message_when_run_then_returns_plan_markdown():
    plan = "# Plan\n\n- do the thing"
    stream = _stream(_assistant(plan), _result(result=None))
    with patch("forge.blueprint.query", stream):
        assert await run_blueprint("add a widget") == plan


async def given_run_when_options_built_then_enables_blueprint_skill():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x")

    assert query.call_args.kwargs["options"].skills == ["blueprint"]


async def given_run_when_options_built_then_uses_plan_permission_mode():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x")

    assert query.call_args.kwargs["options"].permission_mode == "plan"


async def given_run_when_options_built_then_uses_opus_model():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x")

    model = query.call_args.kwargs["options"].model
    assert model == BLUEPRINT_MODEL
    assert "opus" in model


async def given_run_when_options_built_then_uses_high_effort():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x")

    assert query.call_args.kwargs["options"].effort == "high"


async def given_a_request_when_run_then_passes_it_through_as_prompt():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("fix the parser bug")

    assert query.call_args.kwargs["prompt"] == "fix the parser bug"


async def given_a_cwd_when_run_then_runs_against_that_working_directory():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x", cwd="/repo/x")

    assert query.call_args.kwargs["options"].cwd == "/repo/x"


async def given_multiple_assistant_messages_when_run_then_concatenates_text_in_order():
    stream = _stream(
        _assistant("first "),
        _assistant("second"),
        _result(result=None),
    )
    with patch("forge.blueprint.query", stream):
        assert await run_blueprint("x") == "first second"


async def given_empty_result_with_accumulated_text_when_run_then_returns_that_text():
    stream = _stream(_assistant("the real plan"), _result(result=""))
    with patch("forge.blueprint.query", stream):
        assert await run_blueprint("x") == "the real plan"


async def given_run_when_options_built_then_blanks_api_key_and_keeps_other_env():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x")

    env = query.call_args.kwargs["options"].env
    assert env["ANTHROPIC_API_KEY"] == ""
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env


async def given_run_when_options_built_then_blanks_every_non_subscription_auth_var():
    with patch("forge.blueprint.query") as query:
        query.side_effect = _stream(_assistant("plan"), _result())
        await run_blueprint("x")

    env = query.call_args.kwargs["options"].env
    assert "ANTHROPIC_API_KEY" in NON_SUBSCRIPTION_AUTH_ENV_VARS
    assert {"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"} <= set(
        NON_SUBSCRIPTION_AUTH_ENV_VARS
    )
    assert {"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"} <= set(
        NON_SUBSCRIPTION_AUTH_ENV_VARS
    )
    for name in NON_SUBSCRIPTION_AUTH_ENV_VARS:
        assert env[name] == ""
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in NON_SUBSCRIPTION_AUTH_ENV_VARS


@pytest.mark.parametrize("request_text", ["", "   ", "\n\t"])
async def given_blank_request_when_run_then_raises_and_never_calls_query(request_text):
    with patch("forge.blueprint.query") as query, pytest.raises(BlueprintError):
        await run_blueprint(request_text)

    query.assert_not_called()


async def given_error_result_when_run_then_raises_blueprint_error_with_text():
    stream = _stream(_result(result="rate limited", is_error=True))
    with (
        patch("forge.blueprint.query", stream),
        pytest.raises(BlueprintError) as excinfo,
    ):
        await run_blueprint("x")

    assert "rate limited" in str(excinfo.value)


async def given_cli_not_found_when_run_then_raises_blueprint_error_mentioning_cli():
    with (
        patch("forge.blueprint.query", _raising(CLINotFoundError("claude not found"))),
        pytest.raises(BlueprintError) as excinfo,
    ):
        await run_blueprint("x")

    assert "claude" in str(excinfo.value).lower()


async def given_process_error_mid_stream_when_run_then_wraps_in_blueprint_error():
    with (
        patch("forge.blueprint.query", _raising(ProcessError("boom"))),
        pytest.raises(BlueprintError),
    ):
        await run_blueprint("x")


async def given_no_text_and_no_result_when_run_then_raises_blueprint_error():
    stream = _stream(_result(result=None))
    with patch("forge.blueprint.query", stream), pytest.raises(BlueprintError):
        await run_blueprint("x")


async def given_mixed_content_blocks_when_run_then_ignores_non_text_blocks():
    message = AssistantMessage(
        content=[
            ToolUseBlock(id="t1", name="Read", input={}),
            TextBlock(text="the plan"),
        ],
        model=BLUEPRINT_MODEL,
    )
    stream = _stream(message, _result(result=None))
    with patch("forge.blueprint.query", stream):
        assert await run_blueprint("x") == "the plan"
