import json
from subprocess import CalledProcessError
from unittest.mock import patch

import pytest

from forge.github import GitHubCliError, TriageIssue, fetch_triage_issues


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
