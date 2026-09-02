from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    CLINotFoundError,
    ProcessError,
    ResultMessage,
    TextBlock,
)

from forge.forge_agent import (
    FORGE_MAX_BUDGET_USD,
    FORGE_MODEL,
    FORGE_REVIEWER_AGENT_NAMES,
    FORGE_SKILLS,
    ForgeError,
    ForgeResult,
    _classify_output,
    _load_agent_definition,
    _load_prompt,
    run_forge,
)

pytestmark = pytest.mark.asyncio

_PR_URL = "https://github.com/o/r/pull/12"


def _assistant(*texts: str) -> AssistantMessage:
    return AssistantMessage(
        content=[TextBlock(text=text) for text in texts], model=FORGE_MODEL
    )


def _result(
    result: str | None = "ok",
    is_error: bool = False,
    subtype: str = "success",
    total_cost_usd: float | None = 1.23,
    session_id: str = "s",
) -> ResultMessage:
    return ResultMessage(
        subtype=subtype,
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id=session_id,
        result=result,
        total_cost_usd=total_cost_usd,
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


async def given_a_mocked_query_when_options_built_then_uses_sonnet_model():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    model = query.call_args.kwargs["options"].model
    assert model == FORGE_MODEL
    assert "sonnet" in model


async def given_a_mocked_query_when_options_built_then_uses_high_effort():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    assert query.call_args.kwargs["options"].effort == "high"


async def given_a_mocked_query_when_options_built_then_caps_budget_at_four_usd():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    assert query.call_args.kwargs["options"].max_budget_usd == FORGE_MAX_BUDGET_USD
    assert FORGE_MAX_BUDGET_USD == 4.0


async def given_a_mocked_query_when_options_built_then_permits_writing_tools():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    options = query.call_args.kwargs["options"]
    assert options.permission_mode == "bypassPermissions"
    disallowed = set(options.disallowed_tools)
    assert not {"Write", "Edit", "Bash"} & disallowed


async def given_a_mocked_query_when_options_built_then_forces_subscription_auth():
    from forge.blueprint import NON_SUBSCRIPTION_AUTH_ENV_VARS

    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    env = query.call_args.kwargs["options"].env
    for name in NON_SUBSCRIPTION_AUTH_ENV_VARS:
        assert env[name] == ""


async def given_a_mocked_query_when_options_built_then_carries_the_untrusted_contract():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    system_prompt = query.call_args.kwargs["options"].system_prompt
    assert "untrusted" in system_prompt
    assert "FORGE_ERROR:" in system_prompt
    assert (
        "pull request URL" in system_prompt
        or "pull request url" in system_prompt.lower()
    )


async def given_a_mocked_query_when_options_built_then_enables_the_pipeline_skills():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    skills = query.call_args.kwargs["options"].skills
    assert set(FORGE_SKILLS) <= set(skills)
    assert not any(skill.endswith(":blueprint") for skill in skills)


async def given_a_mocked_query_when_options_built_then_provides_reviewer_agents():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    agents = query.call_args.kwargs["options"].agents
    for name in FORGE_REVIEWER_AGENT_NAMES:
        agent = agents[name]
        assert agent.prompt.strip()
        assert agent.description.strip()


async def given_a_mocked_query_when_options_built_then_bundles_the_plugin_on_disk():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement x")

    plugins = query.call_args.kwargs["options"].plugins
    assert len(plugins) == 1
    assert plugins[0]["type"] == "local"
    assert Path(plugins[0]["path"]).joinpath(".claude-plugin", "plugin.json").is_file()


async def given_a_valid_pr_url_result_when_run_then_returns_success():
    stream = _stream(_result(result=_PR_URL, total_cost_usd=1.23))
    with patch("forge.forge_agent.query", stream):
        result = await run_forge("implement x")

    assert result == ForgeResult(pr_url=_PR_URL, cost_usd=1.23)


async def given_the_error_sentinel_when_run_then_raises_with_the_reason():
    stream = _stream(_result(result="FORGE_ERROR: tests do not pass"))
    with patch("forge.forge_agent.query", stream), pytest.raises(ForgeError) as excinfo:
        await run_forge("implement x")

    assert "tests do not pass" in str(excinfo.value)


async def given_a_budget_exceeded_result_when_run_then_raises_budget_specific_error():
    stream = _stream(
        _result(result=None, is_error=True, subtype="error_max_budget_usd")
    )
    with patch("forge.forge_agent.query", stream), pytest.raises(ForgeError) as excinfo:
        await run_forge("implement x")

    message = str(excinfo.value)
    assert "budget" in message.lower()
    assert "4" in message


async def given_prose_without_url_or_sentinel_when_run_then_raises_did_not_produce_pr():
    stream = _stream(_result(result="I opened a PR for you!"))
    with patch("forge.forge_agent.query", stream), pytest.raises(ForgeError) as excinfo:
        await run_forge("implement x")

    assert "did not produce a pull request" in str(excinfo.value)


async def given_a_request_and_cwd_when_run_then_passes_prompt_and_cwd_through():
    with patch("forge.forge_agent.query") as query:
        query.side_effect = _stream(_result(result=_PR_URL))
        await run_forge("implement X", cwd="/repo")

    assert query.call_args.kwargs["prompt"] == "implement X"
    assert query.call_args.kwargs["options"].cwd == "/repo"


async def given_cli_not_found_when_run_then_raises_forge_error_mentioning_cli():
    with (
        patch(
            "forge.forge_agent.query", _raising(CLINotFoundError("claude not found"))
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        await run_forge("implement x")

    assert "claude" in str(excinfo.value).lower()


async def given_a_process_error_mid_stream_when_run_then_wraps_in_forge_error():
    with (
        patch("forge.forge_agent.query", _raising(ProcessError("boom"))),
        pytest.raises(ForgeError),
    ):
        await run_forge("implement x")


@pytest.mark.parametrize("request_text", ["", "   ", "\n\t"])
async def given_a_blank_request_when_run_then_raises_and_never_calls_query(
    request_text,
):
    with patch("forge.forge_agent.query") as query, pytest.raises(ForgeError):
        await run_forge(request_text)

    query.assert_not_called()


@pytest.mark.parametrize(
    "text",
    [
        "https://github.com/o/r/pulls",
        "https://evil.com/o/r/pull/1",
        "https://github.com/x](http://evil.com)/repo/pull/1",
        "https://github.com/`x`/repo/pull/1",
        "https://github.com/o/r pull/1",
    ],
)
async def given_a_pr_url_lookalike_when_classifying_then_raises(text):
    with pytest.raises(ForgeError):
        _classify_output(text)


async def given_a_result_with_no_cost_when_run_then_cost_is_none():
    stream = _stream(_result(result=_PR_URL, total_cost_usd=None))
    with patch("forge.forge_agent.query", stream):
        result = await run_forge("implement x")

    assert result.cost_usd is None


async def given_the_packaged_prompt_file_is_missing_when_loading_then_raises_forge_error():
    missing_resource = MagicMock()
    missing_resource.joinpath.return_value.read_text.side_effect = FileNotFoundError()
    with (
        patch(
            "forge.forge_agent.importlib.resources.files", return_value=missing_resource
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        _load_prompt()

    assert "forge_agent_prompt.md" in str(excinfo.value)


async def given_the_packaged_prompt_file_is_empty_when_loading_then_raises_forge_error():
    empty_resource = MagicMock()
    empty_resource.joinpath.return_value.read_text.return_value = "   "
    with (
        patch(
            "forge.forge_agent.importlib.resources.files", return_value=empty_resource
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        _load_prompt()

    assert "forge_agent_prompt.md" in str(excinfo.value)


async def given_the_packaged_code_reviewer_markdown_when_parsed_then_produces_a_usable_agent_definition():
    agent = _load_agent_definition("code-reviewer")

    assert agent.description.strip()
    assert "---" not in agent.prompt
    assert agent.prompt.startswith("You are a code reviewer.")
    assert agent.model == "sonnet"


async def given_a_missing_agent_markdown_file_when_loading_then_raises_forge_error():
    missing_resource = MagicMock()
    missing_resource.joinpath.return_value.read_text.side_effect = FileNotFoundError()
    with (
        patch(
            "forge.forge_agent.importlib.resources.files", return_value=missing_resource
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        _load_agent_definition("code-reviewer")

    assert "code-reviewer.md" in str(excinfo.value)


async def given_an_empty_agent_markdown_file_when_loading_then_raises_forge_error():
    empty_resource = MagicMock()
    empty_resource.joinpath.return_value.read_text.return_value = "   "
    with (
        patch(
            "forge.forge_agent.importlib.resources.files", return_value=empty_resource
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        _load_agent_definition("security-reviewer")

    assert "security-reviewer.md" in str(excinfo.value)


async def given_agent_markdown_without_frontmatter_when_loading_then_raises_forge_error():
    malformed_resource = MagicMock()
    malformed_resource.joinpath.return_value.read_text.return_value = (
        "just a prompt body with no frontmatter"
    )
    with (
        patch(
            "forge.forge_agent.importlib.resources.files",
            return_value=malformed_resource,
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        _load_agent_definition("code-reviewer")

    assert "code-reviewer.md" in str(excinfo.value)


async def given_agent_markdown_with_unterminated_frontmatter_when_loading_then_raises_forge_error():
    malformed_resource = MagicMock()
    malformed_resource.joinpath.return_value.read_text.return_value = (
        "---\nname: code-reviewer\nno closing marker"
    )
    with (
        patch(
            "forge.forge_agent.importlib.resources.files",
            return_value=malformed_resource,
        ),
        pytest.raises(ForgeError) as excinfo,
    ):
        _load_agent_definition("code-reviewer")

    assert "code-reviewer.md" in str(excinfo.value)
