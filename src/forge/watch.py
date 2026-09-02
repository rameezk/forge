import asyncio
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path

from forge.blueprint import BlueprintError, run_blueprint
from forge.github import (
    READY_LABEL,
    TRIAGE_LABEL,
    GitHubCliError,
    TriageIssue,
    close_issue,
    comment_on_issue,
    create_issue,
    fetch_triage_issues,
)

logger = logging.getLogger(__name__)


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


def _sanitize_for_log(text: str) -> str:
    return text.replace("\r\n", "\\n").replace("\r", "\\n").replace("\n", "\\n")


def _split_plan(plan: str, fallback_title: str) -> tuple[str, str]:
    lines = plan.split("\n")
    for index, line in enumerate(lines):
        if line.strip().startswith("# "):
            title = line.strip()[2:].strip()
            body = "\n".join(lines[:index] + lines[index + 1 :]).strip()
            return title, body
    return fallback_title, plan


def _plan_body(body: str, issue: TriageIssue) -> str:
    return f"{body}\n\n---\n\nPlanned from #{issue.number}."


FAILURE_REASON_LIMIT = 2000
IN_PROGRESS_COMMENT = "🔨 Forge is running a blueprint on this issue."


def _fence(content: str) -> str:
    longest_run = 0
    current_run = 0
    for char in content:
        if char == "`":
            current_run += 1
            longest_run = max(longest_run, current_run)
        else:
            current_run = 0
    fence = "`" * max(3, longest_run + 1)
    return f"{fence}\n{content}\n{fence}"


def _failure_comment(reason: str) -> str:
    trimmed = reason.strip()[:FAILURE_REASON_LIMIT]
    return (
        "Forge could not plan this issue. The reason below is untrusted output "
        "and is shown verbatim inside a code block:\n\n" + _fence(trimmed)
    )


async def process_issue(issue: TriageIssue, cwd: str | Path | None) -> None:
    try:
        comment_on_issue(issue.number, IN_PROGRESS_COMMENT)
        logger.info("commented that a blueprint is running on #%d", issue.number)
    except GitHubCliError as error:
        logger.warning(
            "could not comment on #%d that a blueprint is running: %s",
            issue.number,
            error,
        )

    try:
        plan = await run_blueprint(_issue_to_request(issue), cwd=cwd)
    except BlueprintError as error:
        try:
            comment_on_issue(issue.number, _failure_comment(str(error)))
        except GitHubCliError as comment_error:
            raise BlueprintError(
                f"{error} (posting the failure comment also failed: {comment_error})"
            ) from comment_error
        raise
    title, body = _split_plan(plan, issue.title)
    url = create_issue(title, _plan_body(body, issue), label=READY_LABEL)
    close_issue(issue.number)
    logger.info("published plan %s for #%d and closed it", url, issue.number)


async def watch(
    cwd: str | Path | None = None, label: str = TRIAGE_LABEL
) -> WatchReport:
    logger.info("starting triage watch (label=%s)", label)
    try:
        issues = fetch_triage_issues(label)
    except GitHubCliError as error:
        logger.error("could not fetch triage issues: %s", error)
        logger.debug("gh detail for fetch: %s", getattr(error, "detail", None))
        raise

    if not issues:
        logger.info("no triage issues found, nothing to do")
        return WatchReport()

    logger.info("found %d triage issue(s)", len(issues))

    results: list[WatchResult] = []
    for issue in issues:
        logger.info(
            "planning issue #%d: %s", issue.number, _sanitize_for_log(issue.title)
        )
        try:
            await process_issue(issue, cwd)
            results.append(WatchResult(issue=issue, ok=True))
        except (BlueprintError, GitHubCliError) as error:
            logger.error(
                "issue #%d failed: %s", issue.number, _sanitize_for_log(str(error))
            )
            logger.debug(
                "gh detail for #%d: %s",
                issue.number,
                getattr(error, "detail", None),
            )
            results.append(WatchResult(issue=issue, ok=False, error=str(error)))

    return WatchReport(results=results)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
        force=True,
    )
    report = asyncio.run(watch())
    failed_count = len(report.failures)
    ok_count = len(report.results) - failed_count
    logger.info("watch complete: %d ok, %d failed", ok_count, failed_count)
    if not report.ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
