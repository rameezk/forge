from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from forge.blueprint import BlueprintError
from forge.github import GitHubCliError, TriageIssue
from forge.watch import (
    WatchReport,
    WatchResult,
    _issue_to_request,
    _plan_body,
    _split_plan,
    main,
    process_issue,
    watch,
)


def _issue(
    number: int = 7, title: str = "Add export", body: str = "as CSV"
) -> TriageIssue:
    return TriageIssue(number=number, title=title, body=body, url=f"https://x/{number}")


def given_an_issue_when_composing_a_request_then_contains_title_and_body():
    request = _issue_to_request(_issue(title="Add export", body="as CSV"))

    assert "Add export" in request
    assert "as CSV" in request


async def given_one_issue_when_processing_then_creates_titled_ready_issue():
    issue = _issue(number=7)
    with (
        patch(
            "forge.watch.run_blueprint",
            AsyncMock(return_value="# Add CSV export\n\n## Summary\ns"),
        ) as blueprint,
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


async def given_one_issue_when_processing_then_creates_before_closing_original():
    recorder = MagicMock()
    with (
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
        patch("forge.watch.run_blueprint", AsyncMock()) as blueprint,
        patch("forge.watch.create_issue") as create,
        patch("forge.watch.close_issue") as close,
    ):
        report = await watch()

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


async def given_a_fetch_failure_when_watching_then_the_error_propagates():
    with (
        patch("forge.watch.fetch_triage_issues", side_effect=GitHubCliError("down")),
        pytest.raises(GitHubCliError),
    ):
        await watch()


def given_an_all_ok_report_when_running_main_then_does_not_exit_nonzero():
    report = WatchReport(results=[WatchResult(issue=_issue(number=1), ok=True)])
    with (
        patch("forge.watch.watch", MagicMock()),
        patch("forge.watch.asyncio.run", return_value=report),
    ):
        main()


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
