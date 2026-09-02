import json
import subprocess
from dataclasses import dataclass

TRIAGE_LABEL = "forge:triage"
READY_LABEL = "forge:ready"
BUILDING_LABEL = "forge:building"
DONE_LABEL = "forge:done"
FAILED_LABEL = "forge:failed"


class GitHubCliError(Exception):
    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.detail = detail


def _reject_flag_like_label(label: str) -> None:
    if label.startswith("-"):
        raise GitHubCliError(
            f"invalid label {label!r}: labels must not start with '-' "
            "to avoid being parsed as a gh flag"
        )


@dataclass(frozen=True)
class TriageIssue:
    number: int
    title: str
    body: str
    url: str


def fetch_triage_issues(label: str = TRIAGE_LABEL) -> list[TriageIssue]:
    _reject_flag_like_label(label)

    try:
        result = subprocess.run(
            [
                "gh",
                "issue",
                "list",
                "--label",
                label,
                "--json",
                "number,title,body,url",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as error:
        raise GitHubCliError(
            "gh CLI was not found on PATH; install GitHub CLI to fetch triage issues"
        ) from error
    except subprocess.CalledProcessError as error:
        raise GitHubCliError("gh issue list failed", detail=error.stderr) from error

    try:
        entries = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise GitHubCliError(f"could not parse gh output as JSON: {error}") from error

    try:
        return [
            TriageIssue(
                number=entry["number"],
                title=entry["title"],
                body=entry["body"] or "",
                url=entry["url"],
            )
            for entry in entries
        ]
    except (KeyError, TypeError) as error:
        raise GitHubCliError(
            f"unexpected gh issue list output shape: {error}"
        ) from error


def comment_on_issue(number: int, body: str) -> None:
    try:
        subprocess.run(
            ["gh", "issue", "comment", str(number), "--body-file", "-"],
            input=body,
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as error:
        raise GitHubCliError(
            "gh CLI was not found on PATH; install GitHub CLI to comment on issues"
        ) from error
    except subprocess.CalledProcessError as error:
        raise GitHubCliError("gh issue comment failed", detail=error.stderr) from error


def create_issue(title: str, body: str, *, label: str | None = None) -> str:
    if label is not None:
        _reject_flag_like_label(label)

    argv = ["gh", "issue", "create", "--title", title, "--body-file", "-"]
    if label is not None:
        argv += ["--label", label]

    try:
        result = subprocess.run(
            argv,
            input=body,
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as error:
        raise GitHubCliError(
            "gh CLI was not found on PATH; install GitHub CLI to create issues"
        ) from error
    except subprocess.CalledProcessError as error:
        raise GitHubCliError("gh issue create failed", detail=error.stderr) from error

    return result.stdout.strip()


def close_issue(number: int) -> None:
    try:
        subprocess.run(
            ["gh", "issue", "close", str(number)],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as error:
        raise GitHubCliError(
            "gh CLI was not found on PATH; install GitHub CLI to close issues"
        ) from error
    except subprocess.CalledProcessError as error:
        raise GitHubCliError("gh issue close failed", detail=error.stderr) from error


def relabel_issue(
    number: int, *, add: str | None = None, remove: str | None = None
) -> None:
    if add is not None:
        _reject_flag_like_label(add)
    if remove is not None:
        _reject_flag_like_label(remove)

    argv = ["gh", "issue", "edit", str(number)]
    if add is not None:
        argv += ["--add-label", add]
    if remove is not None:
        argv += ["--remove-label", remove]

    try:
        subprocess.run(argv, capture_output=True, text=True, check=True)
    except FileNotFoundError as error:
        raise GitHubCliError(
            "gh CLI was not found on PATH; install GitHub CLI to relabel issues"
        ) from error
    except subprocess.CalledProcessError as error:
        raise GitHubCliError("gh issue edit failed", detail=error.stderr) from error
