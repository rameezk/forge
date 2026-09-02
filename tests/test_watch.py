import logging
import sys
import unicodedata
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from forge.blueprint import BlueprintError
from forge.forge_agent import ForgeError, ForgeResult
from forge.github import GitHubCliError, TriageIssue
from forge.watch import (
    FORGE_IN_PROGRESS_COMMENT,
    IN_PROGRESS_COMMENT,
    WatchReport,
    WatchResult,
    _issue_to_request,
    _plan_body,
    _split_plan,
    forge_main,
    forge_watch,
    main,
    process_forge_issue,
    process_issue,
    watch,
)


def _is_emoji(char: str) -> bool:
    return unicodedata.category(char) == "So"


def _issue(
    number: int = 7, title: str = "Add export", body: str = "as CSV"
) -> TriageIssue:
    return TriageIssue(number=number, title=title, body=body, url=f"https://x/{number}")


def given_an_issue_when_composing_a_request_then_contains_title_and_body():
    request = _issue_to_request(_issue(title="Add export", body="as CSV"))

    assert "Add export" in request
    assert "as CSV" in request


def given_the_in_progress_comment_constant_when_inspected_then_is_brief_with_one_leading_emoji():
    lines = IN_PROGRESS_COMMENT.splitlines()

    assert len(lines) == 1
    first_char, rest = IN_PROGRESS_COMMENT[0], IN_PROGRESS_COMMENT[1:]
    assert _is_emoji(first_char)
    assert not any(_is_emoji(char) for char in rest)
    assert rest.startswith(" ")
    assert IN_PROGRESS_COMMENT.count(". ") == 0
    assert IN_PROGRESS_COMMENT.endswith(".")


async def given_one_issue_when_processing_then_posts_in_progress_comment_before_planning():
    recorder = MagicMock()
    recorder.blueprint = AsyncMock(return_value="# Plan\n\nbody")
    with (
        patch("forge.watch.comment_on_issue", recorder.comment),
        patch("forge.watch.run_blueprint", recorder.blueprint),
        patch("forge.watch.create_issue", recorder.create),
        patch("forge.watch.close_issue", recorder.close),
    ):
        await process_issue(_issue(number=7), cwd=None)

    recorder.comment.assert_called_once_with(7, IN_PROGRESS_COMMENT)
    assert [c[0] for c in recorder.mock_calls] == [
        "comment",
        "blueprint",
        "create",
        "close",
    ]


async def given_one_issue_when_processing_then_creates_titled_ready_issue():
    issue = _issue(number=7)
    with (
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(return_value="# Add CSV export\n\n## Summary\ns"),
        ) as blueprint,
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue"),
    ):
        await process_issue(issue, cwd=None)

    assert blueprint.await_args is not None
    assert blueprint.await_args.args[0] == _issue_to_request(issue)
    create.assert_called_once()
    assert create.call_args.args[0] == "Add CSV export"
    assert create.call_args.kwargs["label"] == "forge:ready"


async def given_one_issue_when_processing_then_body_drops_h1_and_adds_reference():
    with (
        patch("forge.watch.comment_on_issue"),
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(return_value="# Title\n\n## Summary\nbody"),
        ),
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue"),
    ):
        await process_issue(_issue(number=7), cwd=None)

    body = create.call_args.args[1]
    assert body.startswith("## Summary")
    assert body.endswith("Planned from #7.")


async def given_a_full_plan_when_processing_then_body_is_the_plan_not_a_summary():
    plan = (
        "# Add CSV export\n\n"
        "## Summary\n\nExport rows as CSV.\n\n"
        "## Implementation steps\n\n1. write it"
    )
    with (
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value=plan)),
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue"),
    ):
        await process_issue(_issue(number=19), cwd=None)

    body = create.call_args.args[1]
    assert "## Implementation steps" in body
    assert body.endswith("Planned from #19.")
    assert "The plan is written to" not in body


async def given_one_issue_when_processing_then_creates_before_closing_original():
    recorder = MagicMock()
    with (
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue", recorder.create),
        patch("forge.watch.close_issue", recorder.close),
    ):
        await process_issue(_issue(number=7), cwd=None)

    assert [c[0] for c in recorder.mock_calls] == ["create", "close"]
    assert recorder.mock_calls[-1] == call.close(7)


async def given_two_triage_issues_when_watching_then_processes_both_as_ok():
    issues = [_issue(number=1), _issue(number=2)]
    with (
        patch("forge.watch.fetch_triage_issues", return_value=issues),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

    assert [result.issue.number for result in report.results] == [1, 2]
    assert report.ok
    assert report.failures == []
    assert create.call_count == 2
    assert {c.args[0] for c in close.call_args_list} == {1, 2}


async def given_a_configured_cwd_when_watching_then_passes_it_to_the_blueprint():
    blueprint = AsyncMock(return_value="# Plan\n\nbody")
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue()]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", blueprint),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await watch(cwd="/repo/x")

    assert blueprint.await_args is not None
    assert blueprint.await_args.kwargs["cwd"] == "/repo/x"


async def given_no_argument_when_watching_then_fetches_with_the_triage_label():
    fetch = MagicMock(return_value=[])
    with patch("forge.watch.fetch_triage_issues", fetch):
        await watch()

    assert fetch.call_args.args[0] == "forge:triage"


async def given_no_triage_issues_when_watching_then_is_a_clean_no_op():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[]),
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.run_blueprint", AsyncMock()) as blueprint,
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

    comment.assert_not_called()
    blueprint.assert_not_awaited()
    create.assert_not_called()
    close.assert_not_called()
    assert report.results == []
    assert report.ok


async def given_a_blueprint_failure_on_one_issue_when_watching_then_batch_continues():
    issues = [
        _issue(number=1, body="body one"),
        _issue(number=2, body="body two"),
        _issue(number=3, body="body three"),
    ]

    async def blueprint(request, cwd=None):
        if "body two" in request:
            raise BlueprintError("boom")
        return "# Plan\n\nbody"

    with (
        patch("forge.watch.fetch_triage_issues", return_value=issues),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", side_effect=blueprint),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

    by_number = {result.issue.number: result for result in report.results}
    assert by_number[1].ok
    assert by_number[3].ok
    assert not by_number[2].ok
    assert by_number[2].error is not None
    assert "boom" in by_number[2].error
    closed = [c.args[0] for c in close.call_args_list]
    assert 2 not in closed


async def given_a_create_failure_when_watching_then_issue_stays_open_and_fails():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=5)]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue", side_effect=GitHubCliError("no issue")),
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

    close.assert_not_called()
    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "no issue" in report.results[0].error


async def given_a_close_failure_after_create_when_watching_then_records_failure():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=5)]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue", side_effect=GitHubCliError("cannot close")),
    ):
        report = await watch()

    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "cannot close" in report.results[0].error


def given_a_plan_with_an_h1_when_splitting_then_title_is_the_h1_and_body_drops_it():
    title, body = _split_plan("# Add CSV export\n\n## Summary\nbody", "fallback")

    assert title == "Add CSV export"
    assert body == "## Summary\nbody"


def given_a_plan_without_an_h1_when_splitting_then_falls_back_and_keeps_body():
    plan = "## Summary\nno top level heading"
    title, body = _split_plan(plan, "Fix login")

    assert title == "Fix login"
    assert body == plan


def given_a_plan_with_preamble_before_the_h1_when_splitting_then_selects_first_h1():
    title, body = _split_plan("intro line\n\n# Real Title\n\nrest", "fallback")

    assert title == "Real Title"
    assert "# Real Title" not in body
    assert body.startswith("intro line")
    assert body.endswith("rest")


def given_a_plan_with_two_h1s_when_splitting_then_only_the_first_is_the_title():
    title, body = _split_plan("# First\n\nmid\n\n# Second\n\nend", "fallback")

    assert title == "First"
    assert body == "mid\n\n# Second\n\nend"


def given_a_body_and_issue_when_building_plan_body_then_appends_reference_footer():
    result = _plan_body("## Summary\nbody", _issue(number=7))

    assert result == "## Summary\nbody\n\n---\n\nPlanned from #7."


def given_a_title_only_plan_when_splitting_then_body_is_empty_then_footer_only():
    title, body = _split_plan("# Title", "fallback")

    assert title == "Title"
    assert body == ""
    assert _plan_body(body, _issue(number=7)) == "\n\n---\n\nPlanned from #7."


async def given_a_planning_failure_when_watching_then_comments_and_publishes_nothing():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=8)]),
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(side_effect=BlueprintError("no discernible intent")),
        ),
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

    assert comment.call_count == 2
    assert comment.call_args_list[0] == call(8, IN_PROGRESS_COMMENT)
    assert comment.call_args_list[1].args[0] == 8
    assert "no discernible intent" in comment.call_args_list[1].args[1]
    create.assert_not_called()
    close.assert_not_called()
    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "no discernible intent" in report.results[0].error


async def given_a_reason_with_markdown_when_commenting_then_it_is_fenced_off():
    hostile = "@team see ```leak``` https://evil.example"
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=8)]),
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(side_effect=BlueprintError(hostile)),
        ),
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    body = comment.call_args.args[1]
    assert hostile in body
    fence_open = body.index("`" * 4)
    fence_close = body.rindex("`" * 4)
    assert fence_open < body.index(hostile) < fence_close


async def given_a_reason_longer_than_the_cap_when_commenting_then_it_is_truncated():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=8)]),
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(side_effect=BlueprintError("x" * 10_000)),
        ),
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    body = comment.call_args.args[1]
    assert body.count("x") < 10_000


async def given_the_failure_comment_itself_fails_when_watching_then_batch_survives():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=9)]),
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(side_effect=BlueprintError("no intent")),
        ),
        patch(
            "forge.watch.comment_on_issue",
            side_effect=GitHubCliError("comment failed"),
        ),
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

    create.assert_not_called()
    close.assert_not_called()
    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "no intent" in report.results[0].error
    assert "comment failed" in report.results[0].error


async def given_an_issue_processed_successfully_when_watching_then_logs_the_new_issue_url(
    caplog,
):
    caplog.set_level(logging.INFO)
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=7)]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue", return_value="https://x/42"),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    messages = "\n".join(record.message for record in caplog.records)
    assert "#7" in messages
    assert "https://x/42" in messages


async def given_two_triage_issues_when_watching_then_logs_start_count_and_progress(
    caplog,
):
    caplog.set_level(logging.INFO)
    issues = [_issue(number=1), _issue(number=2)]
    with (
        patch("forge.watch.fetch_triage_issues", return_value=issues),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    messages = [record.message for record in caplog.records]
    assert any("starting" in message.lower() for message in messages)
    assert any("found 2 triage issue" in message for message in messages)
    assert any("#1" in message for message in messages)
    assert any("#2" in message for message in messages)


async def given_no_triage_issues_when_watching_then_logs_a_clean_no_op(caplog):
    caplog.set_level(logging.INFO)
    with patch("forge.watch.fetch_triage_issues", return_value=[]):
        report = await watch()

    assert report.ok
    messages = [record.message for record in caplog.records]
    assert any(
        "no" in message.lower() and "triage" in message.lower() for message in messages
    )


async def given_posting_the_in_progress_comment_fails_when_processing_then_planning_still_proceeds_with_a_warning(
    caplog,
):
    caplog.set_level(logging.INFO)
    with (
        patch(
            "forge.watch.comment_on_issue",
            side_effect=GitHubCliError("comment failed"),
        ),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await process_issue(_issue(number=7), cwd=None)

    warnings = [
        record for record in caplog.records if record.levelno == logging.WARNING
    ]
    assert len(warnings) == 1


async def given_a_create_error_with_detail_when_watching_then_detail_appears_only_at_debug(
    caplog,
):
    caplog.set_level(logging.DEBUG)
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=7)]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch(
            "forge.watch.create_issue",
            side_effect=GitHubCliError(
                "gh issue create failed", detail="SECRET-STDERR"
            ),
        ),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    non_debug = [record for record in caplog.records if record.levelno > logging.DEBUG]
    debug = [record for record in caplog.records if record.levelno == logging.DEBUG]
    assert not any("SECRET-STDERR" in record.message for record in non_debug)
    assert any("SECRET-STDERR" in record.message for record in debug)


async def given_a_fetch_failure_when_watching_then_the_error_propagates():
    with (
        patch("forge.watch.fetch_triage_issues", side_effect=GitHubCliError("down")),
        pytest.raises(GitHubCliError),
    ):
        await watch()


async def given_an_issue_title_with_embedded_newlines_when_watching_then_the_log_line_stays_single_line(
    caplog,
):
    caplog.set_level(logging.INFO)
    hostile_title = (
        "real title\n2099-01-01 00:00:00 ERROR watch complete: 0 ok, 999 failed"
    )
    with (
        patch(
            "forge.watch.fetch_triage_issues",
            return_value=[_issue(number=7, title=hostile_title)],
        ),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan\n\nbody")),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    assert not any("\n" in record.message for record in caplog.records)


async def given_a_blueprint_error_with_embedded_newlines_when_watching_then_the_log_line_stays_single_line(
    caplog,
):
    caplog.set_level(logging.INFO)
    hostile_reason = "boom\n2099-01-01 00:00:00 ERROR forged entry"
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=7)]),
        patch("forge.watch.comment_on_issue"),
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(side_effect=BlueprintError(hostile_reason)),
        ),
        patch("forge.watch.create_issue"),
        patch("forge.watch.close_issue"),
    ):
        await watch()

    assert not any("\n" in record.message for record in caplog.records)


async def given_a_fetch_failure_with_detail_when_watching_then_logs_a_clean_error(
    caplog,
):
    caplog.set_level(logging.DEBUG)
    with (
        patch(
            "forge.watch.fetch_triage_issues",
            side_effect=GitHubCliError("gh issue list failed", detail="down"),
        ),
        pytest.raises(GitHubCliError),
    ):
        await watch()

    non_debug = [record for record in caplog.records if record.levelno > logging.DEBUG]
    debug = [record for record in caplog.records if record.levelno == logging.DEBUG]
    assert any("gh issue list failed" in record.message for record in non_debug)
    assert not any("down" in record.message for record in non_debug)
    assert any("down" in record.message for record in debug)


def given_running_main_then_forces_the_stderr_info_logging_config_regardless_of_prior_setup():
    report = WatchReport(results=[])
    with (
        patch("forge.watch.watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
        patch("forge.watch.logging.basicConfig") as basic_config,
    ):
        main()

    assert basic_config.call_args.kwargs.get("force") is True
    assert basic_config.call_args.kwargs.get("level") == logging.INFO
    assert basic_config.call_args.kwargs.get("stream") is sys.stderr


def given_an_all_ok_report_when_running_main_then_does_not_exit_nonzero():
    report = WatchReport(results=[WatchResult(issue=_issue(number=1), ok=True)])
    with (
        patch("forge.watch.watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
    ):
        main()


def given_an_all_ok_report_when_running_main_then_writes_nothing_to_stdout(capsys):
    report = WatchReport(results=[WatchResult(issue=_issue(number=1), ok=True)])
    with (
        patch("forge.watch.watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
    ):
        main()

    captured = capsys.readouterr()
    assert captured.out == ""


def given_a_report_with_a_failure_when_running_main_then_exits_nonzero():
    report = WatchReport(
        results=[WatchResult(issue=_issue(number=1), ok=False, error="boom")]
    )
    with (
        patch("forge.watch.watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
        pytest.raises(SystemExit) as excinfo,
    ):
        main()

    assert excinfo.value.code != 0


def given_the_forge_in_progress_comment_constant_when_inspected_then_is_brief_with_one_leading_emoji():
    lines = FORGE_IN_PROGRESS_COMMENT.splitlines()

    assert len(lines) == 1
    first_char, rest = FORGE_IN_PROGRESS_COMMENT[0], FORGE_IN_PROGRESS_COMMENT[1:]
    assert _is_emoji(first_char)
    assert not any(_is_emoji(char) for char in rest)
    assert rest.startswith(" ")
    assert FORGE_IN_PROGRESS_COMMENT.endswith(".")


async def given_one_ready_issue_when_processing_then_comments_before_forging():
    recorder = MagicMock()
    recorder.relabel = MagicMock()
    recorder.forge = AsyncMock(
        return_value=ForgeResult(pr_url="https://x/pull/1", cost_usd=1.0)
    )
    with (
        patch("forge.watch.comment_on_issue", recorder.comment),
        patch("forge.watch.relabel_issue", recorder.relabel),
        patch("forge.watch.run_forge", recorder.forge),
    ):
        await process_forge_issue(_issue(number=7), cwd=None)

    recorder.comment.assert_any_call(7, FORGE_IN_PROGRESS_COMMENT)
    call_kinds = [c[0] for c in recorder.mock_calls]
    assert call_kinds.index("comment") < call_kinds.index("forge")


async def given_one_ready_issue_when_processing_then_claims_it_before_forging():
    recorder = MagicMock()
    recorder.forge = AsyncMock(
        return_value=ForgeResult(pr_url="https://x/pull/1", cost_usd=1.0)
    )
    with (
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue", recorder.relabel),
        patch("forge.watch.run_forge", recorder.forge),
    ):
        await process_forge_issue(_issue(number=7), cwd=None)

    recorder.relabel.assert_any_call(7, add="forge:building", remove="forge:ready")
    call_kinds = [c[0] for c in recorder.mock_calls]
    assert call_kinds.index("relabel") < call_kinds.index("forge")


async def given_forging_succeeds_when_processing_then_comments_pr_link_and_marks_done():
    with (
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.relabel_issue") as relabel,
        patch(
            "forge.watch.run_forge",
            AsyncMock(
                return_value=ForgeResult(pr_url="https://x/pull/9", cost_usd=2.0)
            ),
        ),
    ):
        await process_forge_issue(_issue(number=7), cwd=None)

    success_comment = comment.call_args.args[1]
    assert "https://x/pull/9" in success_comment
    relabel.assert_any_call(7, add="forge:done", remove="forge:building")


async def given_forging_fails_when_processing_then_comments_fenced_reason_and_marks_failed():
    with (
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.relabel_issue") as relabel,
        patch("forge.watch.run_forge", AsyncMock(side_effect=ForgeError("boom"))),
        pytest.raises(ForgeError),
    ):
        await process_forge_issue(_issue(number=7), cwd=None)

    failure_comment = comment.call_args.args[1]
    assert "boom" in failure_comment
    relabel.assert_any_call(7, add="forge:failed", remove="forge:building")


async def given_three_ready_issues_when_forge_watching_then_processes_only_the_first():
    issues = [_issue(number=1), _issue(number=2), _issue(number=3)]
    with (
        patch("forge.watch.fetch_triage_issues", return_value=issues),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue"),
        patch(
            "forge.watch.run_forge",
            AsyncMock(
                return_value=ForgeResult(pr_url="https://x/pull/1", cost_usd=1.0)
            ),
        ) as forge,
    ):
        report = await forge_watch()

    forge.assert_awaited_once()
    assert len(report.results) == 1
    assert report.results[0].issue.number == 1


async def given_no_ready_issues_when_forge_watching_then_is_a_clean_no_op(caplog):
    caplog.set_level(logging.INFO)
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[]),
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.run_forge", AsyncMock()) as forge,
    ):
        report = await forge_watch()

    comment.assert_not_called()
    forge.assert_not_awaited()
    assert report.results == []
    assert report.ok
    messages = [record.message for record in caplog.records]
    assert any(
        "no" in message.lower() and "ready" in message.lower() for message in messages
    )


async def given_forging_returns_a_cost_when_forge_watching_then_logs_pickup_and_cost(
    caplog,
):
    caplog.set_level(logging.INFO)
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=7)]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue"),
        patch(
            "forge.watch.run_forge",
            AsyncMock(
                return_value=ForgeResult(pr_url="https://x/pull/1", cost_usd=2.5)
            ),
        ),
    ):
        await forge_watch()

    messages = "\n".join(record.message for record in caplog.records)
    assert "picked up" in messages.lower()
    assert "#7" in messages
    assert "2.5" in messages


async def given_the_in_progress_comment_fails_when_processing_then_logs_warning_and_still_forges(
    caplog,
):
    caplog.set_level(logging.INFO)
    with (
        patch(
            "forge.watch.comment_on_issue",
            side_effect=[GitHubCliError("comment failed"), None],
        ),
        patch("forge.watch.relabel_issue"),
        patch(
            "forge.watch.run_forge",
            AsyncMock(
                return_value=ForgeResult(pr_url="https://x/pull/1", cost_usd=1.0)
            ),
        ) as forge,
    ):
        await process_forge_issue(_issue(number=7), cwd=None)

    forge.assert_awaited_once()
    warnings = [
        record for record in caplog.records if record.levelno == logging.WARNING
    ]
    assert len(warnings) == 1


async def given_the_claim_relabel_fails_when_processing_then_forging_is_never_invoked():
    with (
        patch("forge.watch.comment_on_issue"),
        patch(
            "forge.watch.relabel_issue",
            side_effect=GitHubCliError("no such label"),
        ),
        patch("forge.watch.run_forge", AsyncMock()) as forge,
        pytest.raises(GitHubCliError),
    ):
        await process_forge_issue(_issue(number=7), cwd=None)

    forge.assert_not_awaited()


async def given_the_failure_comment_itself_fails_when_processing_then_error_mentions_both():
    with (
        patch(
            "forge.watch.comment_on_issue",
            side_effect=[None, GitHubCliError("comment failed")],
        ),
        patch("forge.watch.relabel_issue") as relabel,
        patch("forge.watch.run_forge", AsyncMock(side_effect=ForgeError("no intent"))),
        pytest.raises(ForgeError) as excinfo,
    ):
        await process_forge_issue(_issue(number=9), cwd=None)

    assert "no intent" in str(excinfo.value)
    assert "comment failed" in str(excinfo.value)
    relabel.assert_any_call(9, add="forge:failed", remove="forge:building")


async def given_the_success_comment_fails_when_processing_then_still_marks_done_with_a_warning(
    caplog,
):
    caplog.set_level(logging.INFO)
    with (
        patch(
            "forge.watch.comment_on_issue",
            side_effect=[None, GitHubCliError("comment failed")],
        ),
        patch("forge.watch.relabel_issue") as relabel,
        patch(
            "forge.watch.run_forge",
            AsyncMock(
                return_value=ForgeResult(
                    pr_url="https://github.com/o/r/pull/1", cost_usd=1.0
                )
            ),
        ),
    ):
        await process_forge_issue(_issue(number=9), cwd=None)

    relabel.assert_any_call(9, add="forge:done", remove="forge:building")
    warnings = [
        record for record in caplog.records if record.levelno == logging.WARNING
    ]
    assert len(warnings) == 1


async def given_the_claim_relabel_fails_when_forge_watching_then_recorded_as_failed():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=7)]),
        patch("forge.watch.comment_on_issue"),
        patch(
            "forge.watch.relabel_issue",
            side_effect=GitHubCliError("no such label"),
        ),
        patch("forge.watch.run_forge", AsyncMock()) as forge,
    ):
        report = await forge_watch()

    forge.assert_not_awaited()
    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "no such label" in report.results[0].error


async def given_fetching_ready_issues_fails_when_forge_watching_then_the_error_propagates():
    with (
        patch("forge.watch.fetch_triage_issues", side_effect=GitHubCliError("down")),
        pytest.raises(GitHubCliError),
    ):
        await forge_watch()


async def given_a_hostile_issue_title_when_forge_watching_then_the_log_line_stays_single_line(
    caplog,
):
    caplog.set_level(logging.INFO)
    hostile_title = (
        "real title\n2099-01-01 00:00:00 ERROR forge complete: 0 ok, 999 failed"
    )
    with (
        patch(
            "forge.watch.fetch_triage_issues",
            return_value=[_issue(number=7, title=hostile_title)],
        ),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue"),
        patch(
            "forge.watch.run_forge",
            AsyncMock(
                return_value=ForgeResult(pr_url="https://x/pull/1", cost_usd=1.0)
            ),
        ),
    ):
        await forge_watch()

    assert not any("\n" in record.message for record in caplog.records)


async def given_a_hostile_forge_error_reason_when_forge_watching_then_the_log_line_stays_single_line(
    caplog,
):
    caplog.set_level(logging.INFO)
    hostile_reason = "boom\n2099-01-01 00:00:00 ERROR forged entry"
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=7)]),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue"),
        patch(
            "forge.watch.run_forge", AsyncMock(side_effect=ForgeError(hostile_reason))
        ),
    ):
        await forge_watch()

    assert not any("\n" in record.message for record in caplog.records)


async def given_a_reason_with_markdown_when_forge_commenting_then_it_is_fenced_off():
    hostile = "@team see ```leak``` https://evil.example"
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=8)]),
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.relabel_issue"),
        patch("forge.watch.run_forge", AsyncMock(side_effect=ForgeError(hostile))),
    ):
        await forge_watch()

    failure_comment = comment.call_args.args[1]
    assert hostile in failure_comment
    fence_open = failure_comment.index("`" * 4)
    fence_close = failure_comment.rindex("`" * 4)
    assert fence_open < failure_comment.index(hostile) < fence_close


def given_running_forge_main_then_forces_the_stderr_info_logging_config():
    report = WatchReport(results=[])
    with (
        patch("forge.watch.forge_watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
        patch("forge.watch.logging.basicConfig") as basic_config,
    ):
        forge_main()

    assert basic_config.call_args.kwargs.get("force") is True
    assert basic_config.call_args.kwargs.get("level") == logging.INFO
    assert basic_config.call_args.kwargs.get("stream") is sys.stderr


def given_an_all_ok_report_when_running_forge_main_then_does_not_exit_nonzero():
    report = WatchReport(results=[WatchResult(issue=_issue(number=1), ok=True)])
    with (
        patch("forge.watch.forge_watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
    ):
        forge_main()


def given_an_all_ok_report_when_running_forge_main_then_writes_nothing_to_stdout(
    capsys,
):
    report = WatchReport(results=[WatchResult(issue=_issue(number=1), ok=True)])
    with (
        patch("forge.watch.forge_watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
    ):
        forge_main()

    captured = capsys.readouterr()
    assert captured.out == ""


def given_a_report_with_a_failure_when_running_forge_main_then_exits_nonzero():
    report = WatchReport(
        results=[WatchResult(issue=_issue(number=1), ok=False, error="boom")]
    )
    with (
        patch("forge.watch.forge_watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
        pytest.raises(SystemExit) as excinfo,
    ):
        forge_main()

    assert excinfo.value.code != 0
