import json
import subprocess
from dataclasses import dataclass

TRIAGE_LABEL = "forge:triage"


class GitHubCliError(Exception):
    pass


@dataclass(frozen=True)
class TriageIssue:
    number: int
    title: str
    body: str
    url: str


def fetch_triage_issues(label: str = TRIAGE_LABEL) -> list[TriageIssue]:
    if label.startswith("-"):
        raise GitHubCliError(
            f"invalid label {label!r}: labels must not start with '-' "
            "to avoid being parsed as a gh flag"
        )

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
        raise GitHubCliError(f"gh issue list failed: {error.stderr}") from error

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
