# 0119. forge-auto-merge checks the Reviewer App against the default-branch rules

## Status

Accepted

Builds on ADR-0105 and ADR-0116.

## Context

ADR-0116 has the ADR-0105 check verify that the Reviewer App is installed on each opted-in repository and cannot bypass its rules. That check runs in frontier sync, which holds only forge App tokens and must never see the Reviewer App's id or key. A forge App token cannot tell whether another App is installed, and a ruleset's `current_user_can_bypass` answers only for the caller.

- Option 1: `forge-auto-merge` checks its own App with its own credentials: the installation lookup finding none means not installed, and `current_user_can_bypass` read with the Reviewer App's token means bypass. It records the result in the store, where frontier sync and the dashboard show it with the other rule failures.
- Option 2: Frontier sync gets the Reviewer App's public id and matches it against each ruleset's `bypass_actors`. This misses bypass granted through a role or team, needs admin read, and cannot prove the App is installed.
- Option 3: Frontier sync gets the Reviewer App's key, breaking ADR-0116's isolation.

## Decision

We will go with Option 1. A Reviewer App failure is a rule failure like any other: it stops new dispatches to that repository and shows on the Board. `forge-auto-merge` merges nothing in a repository with any outstanding rule failure, ADR-0105's own or the Reviewer App's.

## Consequences

The Reviewer App's key stays only in `forge-auto-merge`, and bypass is judged by GitHub's own answer rather than a reading of `bypass_actors`. The rules check now has two writers, frontier sync and `forge-auto-merge`, and the Reviewer App half is only as fresh as the last auto-merge pass. A repository whose rules weaken stops auto-merging, not only dispatching.
