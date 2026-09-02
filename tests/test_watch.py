from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from forge.blueprint import BlueprintError
from forge.github import GitHubCliError, TriageIssue
from forge.watch import (
    WatchReport,
    WatchResult,
    _issue_to_request,
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


async def given_one_issue_when_processing_then_plans_comments_and_marks_ready():
    issue = _issue(number=7)
    with (
        patch(
            "forge.watch.run_blueprint", AsyncMock(return_value="# Plan")
        ) as blueprint,
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.relabel_issue") as relabel,
    ):
        await process_issue(issue, cwd=None)

    assert blueprint.await_args is not None
    assert blueprint.await_args.args[0] == _issue_to_request(issue)
    comment.assert_called_once_with(7, "# Plan")
    relabel.assert_called_once_with(7, add="forge:ready", remove="forge:triage")


async def given_one_issue_when_processing_then_comments_before_removing_triage_label():
    recorder = MagicMock()
    with (
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan")),
        patch("forge.watch.comment_on_issue", recorder.comment),
        patch("forge.watch.relabel_issue", recorder.relabel),
    ):
        await process_issue(_issue(number=7), cwd=None)

    assert recorder.mock_calls == [
        call.comment(7, "# Plan"),
        call.relabel(7, add="forge:ready", remove="forge:triage"),
    ]


async def given_two_triage_issues_when_watching_then_processes_both_as_ok():
    issues = [_issue(number=1), _issue(number=2)]
    with (
        patch("forge.watch.fetch_triage_issues", return_value=issues),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan")),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue"),
    ):
        report = await watch()

    assert [result.issue.number for result in report.results] == [1, 2]
    assert report.ok
    assert report.failures == []


async def given_a_configured_cwd_when_watching_then_passes_it_to_the_blueprint():
    blueprint = AsyncMock(return_value="# Plan")
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue()]),
        patch("forge.watch.run_blueprint", blueprint),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue"),
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
        patch("forge.watch.comment_on_issue") as comment,
        patch("forge.watch.relabel_issue") as relabel,
    ):
        report = await watch()

    blueprint.assert_not_awaited()
    comment.assert_not_called()
    relabel.assert_not_called()
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
        return "# Plan"

    with (
        patch("forge.watch.fetch_triage_issues", return_value=issues),
        patch("forge.watch.run_blueprint", side_effect=blueprint),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue") as relabel,
    ):
        report = await watch()

    by_number = {result.issue.number: result for result in report.results}
    assert by_number[1].ok
    assert by_number[3].ok
    assert not by_number[2].ok
    assert by_number[2].error is not None
    assert "boom" in by_number[2].error
    relabelled = [c.args[0] for c in relabel.call_args_list]
    assert 2 not in relabelled


async def given_a_comment_failure_when_watching_then_issue_stays_in_triage_and_fails():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=5)]),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan")),
        patch("forge.watch.comment_on_issue", side_effect=GitHubCliError("no issue")),
        patch("forge.watch.relabel_issue") as relabel,
    ):
        report = await watch()

    relabel.assert_not_called()
    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "no issue" in report.results[0].error


async def given_a_relabel_failure_after_comment_when_watching_then_records_failure():
    with (
        patch("forge.watch.fetch_triage_issues", return_value=[_issue(number=5)]),
        patch("forge.watch.run_blueprint", AsyncMock(return_value="# Plan")),
        patch("forge.watch.comment_on_issue"),
        patch("forge.watch.relabel_issue", side_effect=GitHubCliError("missing label")),
    ):
        report = await watch()

    assert not report.results[0].ok
    assert report.results[0].error is not None
    assert "missing label" in report.results[0].error


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
