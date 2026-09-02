import asyncio
import sys
from dataclasses import dataclass, field
from pathlib import Path

from forge.blueprint import BlueprintError, run_blueprint
from forge.github import (
    READY_LABEL,
    TRIAGE_LABEL,
    GitHubCliError,
    TriageIssue,
    comment_on_issue,
    fetch_triage_issues,
    relabel_issue,
)


@dataclass(frozen=True)
class WatchResult:
    issue: TriageIssue
    ok: bool
    error: str | None = None


@dataclass(frozen=True)
class WatchReport:
    results: list[WatchResult] = field(default_factory=list)

    @property
    def failures(self) -> list[WatchResult]:
        return [result for result in self.results if not result.ok]

    @property
    def ok(self) -> bool:
        return not self.failures


def _issue_to_request(issue: TriageIssue) -> str:
    return f"{issue.title}\n\n{issue.body}"


async def process_issue(issue: TriageIssue, cwd: str | Path | None) -> None:
    plan = await run_blueprint(_issue_to_request(issue), cwd=cwd)
    comment_on_issue(issue.number, plan)
    relabel_issue(issue.number, add=READY_LABEL, remove=TRIAGE_LABEL)


async def watch(
    cwd: str | Path | None = None, label: str = TRIAGE_LABEL
) -> WatchReport:
    issues = fetch_triage_issues(label)

    results: list[WatchResult] = []
    for issue in issues:
        try:
            await process_issue(issue, cwd)
            results.append(WatchResult(issue=issue, ok=True))
        except (BlueprintError, GitHubCliError) as error:
            results.append(WatchResult(issue=issue, ok=False, error=str(error)))

    return WatchReport(results=results)


def main() -> None:
    report = asyncio.run(watch())
    for result in report.results:
        status = "ok" if result.ok else "failed"
        line = f"#{result.issue.number} {status}"
        if result.error:
            line += f": {result.error}"
        print(line)
    if not report.ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
