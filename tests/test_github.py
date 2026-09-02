import json
from subprocess import CalledProcessError
from unittest.mock import patch

import pytest

from forge.github import (
    GitHubCliError,
    TriageIssue,
    close_issue,
    comment_on_issue,
    create_issue,
    fetch_triage_issues,
    relabel_issue,
)


def _completed(stdout: str):
    from subprocess import CompletedProcess

    return CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


def given_two_labelled_issues_when_fetching_then_returns_mapped_triage_issues():
    payload = json.dumps(
        [
            {"number": 1, "title": "First", "body": "Body one", "url": "https://x/1"},
            {"number": 2, "title": "Second", "body": "Body two", "url": "https://x/2"},
        ]
    )
    with patch("forge.github.subprocess.run", return_value=_completed(payload)):
        issues = fetch_triage_issues()

    assert issues == [
        TriageIssue(number=1, title="First", body="Body one", url="https://x/1"),
        TriageIssue(number=2, title="Second", body="Body two", url="https://x/2"),
    ]


def given_no_argument_when_fetching_then_passes_triage_label_and_json_fields():
    with patch("forge.github.subprocess.run", return_value=_completed("[]")) as run:
        fetch_triage_issues()

    argv = run.call_args.args[0]
    assert "--label" in argv
    assert argv[argv.index("--label") + 1] == "forge:triage"
    assert "--json" in argv
    assert argv[argv.index("--json") + 1] == "number,title,body,url"


def given_fetching_when_invoking_gh_then_never_uses_a_shell():
    with patch("forge.github.subprocess.run", return_value=_completed("[]")) as run:
        fetch_triage_issues()

    assert run.call_args.kwargs.get("shell", False) is False


def given_label_starting_with_dash_when_fetching_then_raises_githubclierror():
    with pytest.raises(GitHubCliError):
        fetch_triage_issues(label="--repo=attacker/other")


def given_entry_missing_a_field_when_fetching_then_raises_githubclierror():
    payload = json.dumps([{"number": 1, "title": "T", "url": "u"}])
    with (
        patch("forge.github.subprocess.run", return_value=_completed(payload)),
        pytest.raises(GitHubCliError),
    ):
        fetch_triage_issues()


def given_custom_label_when_fetching_then_passes_that_label():
    with patch("forge.github.subprocess.run", return_value=_completed("[]")) as run:
        fetch_triage_issues(label="bug")

    argv = run.call_args.args[0]
    assert argv[argv.index("--label") + 1] == "bug"


def given_markdown_body_when_fetching_then_preserves_body_verbatim():
    body = "# Heading\n\n- item one\n- item two\n\n```py\nprint('hi')\n```"
    payload = json.dumps([{"number": 3, "title": "T", "body": body, "url": "u"}])
    with patch("forge.github.subprocess.run", return_value=_completed(payload)):
        issues = fetch_triage_issues()

    assert issues[0].body == body


def given_no_matching_issues_when_fetching_then_returns_empty_list():
    with patch("forge.github.subprocess.run", return_value=_completed("[]")):
        issues = fetch_triage_issues()

    assert issues == []


def given_null_body_when_fetching_then_body_is_empty_string():
    payload = json.dumps([{"number": 4, "title": "T", "body": None, "url": "u"}])
    with patch("forge.github.subprocess.run", return_value=_completed(payload)):
        issues = fetch_triage_issues()

    assert issues[0].body == ""


def given_gh_not_installed_when_fetching_then_raises_githubclierror_mentioning_gh():
    with (
        patch("forge.github.subprocess.run", side_effect=FileNotFoundError()),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        fetch_triage_issues()

    assert "gh" in str(excinfo.value)


def given_gh_exits_nonzero_when_fetching_then_raises_githubclierror_with_stderr():
    error = CalledProcessError(returncode=1, cmd=["gh"], stderr="not authenticated")
    with (
        patch("forge.github.subprocess.run", side_effect=error),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        fetch_triage_issues()

    assert "not authenticated" in str(excinfo.value)


def given_malformed_stdout_when_fetching_then_raises_githubclierror():
    with (
        patch("forge.github.subprocess.run", return_value=_completed("not json")),
        pytest.raises(GitHubCliError),
    ):
        fetch_triage_issues()


def given_a_body_when_commenting_then_sends_it_on_stdin_via_body_file():
    with patch("forge.github.subprocess.run", return_value=_completed("")) as run:
        comment_on_issue(7, "# Plan")

    argv = run.call_args.args[0]
    assert argv == ["gh", "issue", "comment", "7", "--body-file", "-"]
    assert run.call_args.kwargs.get("input") == "# Plan"
    assert run.call_args.kwargs.get("shell", False) is False


def given_gh_exits_nonzero_when_commenting_then_raises_githubclierror_with_stderr():
    error = CalledProcessError(returncode=1, cmd=["gh"], stderr="no such issue")
    with (
        patch("forge.github.subprocess.run", side_effect=error),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        comment_on_issue(7, "# Plan")

    assert "no such issue" in str(excinfo.value)


def given_add_and_remove_when_relabelling_then_builds_both_flags_for_the_issue():
    with patch("forge.github.subprocess.run", return_value=_completed("")) as run:
        relabel_issue(7, add="forge:ready", remove="forge:triage")

    argv = run.call_args.args[0]
    assert argv[:4] == ["gh", "issue", "edit", "7"]
    assert argv[argv.index("--add-label") + 1] == "forge:ready"
    assert argv[argv.index("--remove-label") + 1] == "forge:triage"
    assert run.call_args.kwargs.get("shell", False) is False


def given_only_add_when_relabelling_then_omits_the_remove_flag():
    with patch("forge.github.subprocess.run", return_value=_completed("")) as run:
        relabel_issue(7, add="forge:ready")

    argv = run.call_args.args[0]
    assert "--add-label" in argv
    assert "--remove-label" not in argv


def given_hostile_add_label_when_relabelling_then_raises_before_invoking_gh():
    with patch("forge.github.subprocess.run") as run, pytest.raises(GitHubCliError):
        relabel_issue(7, add="--repo=attacker/other")

    run.assert_not_called()


def given_hostile_remove_label_when_relabelling_then_raises_before_invoking_gh():
    with patch("forge.github.subprocess.run") as run, pytest.raises(GitHubCliError):
        relabel_issue(7, remove="--repo=attacker/other")

    run.assert_not_called()


def given_gh_exits_nonzero_when_relabelling_then_raises_githubclierror_with_stderr():
    error = CalledProcessError(returncode=1, cmd=["gh"], stderr="missing label")
    with (
        patch("forge.github.subprocess.run", side_effect=error),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        relabel_issue(7, add="forge:ready", remove="forge:triage")

    assert "missing label" in str(excinfo.value)


def given_title_and_body_when_creating_then_sends_body_on_stdin_without_a_shell():
    with patch(
        "forge.github.subprocess.run", return_value=_completed("https://x/42")
    ) as run:
        url = create_issue("Add CSV export", "## Summary\nbody")

    argv = run.call_args.args[0]
    assert argv == [
        "gh",
        "issue",
        "create",
        "--title",
        "Add CSV export",
        "--body-file",
        "-",
    ]
    assert run.call_args.kwargs.get("input") == "## Summary\nbody"
    assert run.call_args.kwargs.get("shell", False) is False
    assert url == "https://x/42"


def given_a_label_when_creating_then_appends_the_label_flag():
    with patch(
        "forge.github.subprocess.run", return_value=_completed("https://x/42\n")
    ) as run:
        url = create_issue("T", "b", label="forge:ready")

    argv = run.call_args.args[0]
    assert argv[argv.index("--label") + 1] == "forge:ready"
    assert url == "https://x/42"


def given_no_label_when_creating_then_omits_the_label_flag():
    with patch("forge.github.subprocess.run", return_value=_completed("u")) as run:
        create_issue("T", "b")

    assert "--label" not in run.call_args.args[0]


def given_hostile_label_when_creating_then_raises_before_invoking_gh():
    with patch("forge.github.subprocess.run") as run, pytest.raises(GitHubCliError):
        create_issue("T", "b", label="--repo=attacker/other")

    run.assert_not_called()


def given_gh_not_installed_when_creating_then_raises_githubclierror_mentioning_gh():
    with (
        patch("forge.github.subprocess.run", side_effect=FileNotFoundError()),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        create_issue("T", "b")

    assert "gh" in str(excinfo.value)


def given_gh_exits_nonzero_when_creating_then_raises_githubclierror_with_stderr():
    error = CalledProcessError(returncode=1, cmd=["gh"], stderr="could not add label")
    with (
        patch("forge.github.subprocess.run", side_effect=error),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        create_issue("T", "b", label="forge:ready")

    assert "could not add label" in str(excinfo.value)


def given_a_number_when_closing_then_invokes_gh_issue_close_without_a_shell():
    with patch("forge.github.subprocess.run", return_value=_completed("")) as run:
        close_issue(7)

    assert run.call_args.args[0] == ["gh", "issue", "close", "7"]
    assert run.call_args.kwargs.get("shell", False) is False


def given_gh_not_installed_when_closing_then_raises_githubclierror_mentioning_gh():
    with (
        patch("forge.github.subprocess.run", side_effect=FileNotFoundError()),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        close_issue(7)

    assert "gh" in str(excinfo.value)


def given_gh_exits_nonzero_when_closing_then_raises_githubclierror_with_stderr():
    error = CalledProcessError(returncode=1, cmd=["gh"], stderr="no such issue")
    with (
        patch("forge.github.subprocess.run", side_effect=error),
        pytest.raises(GitHubCliError) as excinfo,
    ):
        close_issue(7)

    assert "no such issue" in str(excinfo.value)
