# 0109. The pull deploy acts on GitHub as its own GitHub App

## Status

Accepted

Amends ADR-0049 and ADR-0104.

## Context

The box deploys its operator repository's `main` as root. The pull deploy reads that repository and dispatches its `forge-bump` with the same App that forge mints workload tokens from, and an App's permissions apply to every repository it is installed on. A leaked App private key can therefore push a workflow to the operator repository, and `forge-bump` pushing to `main` with the built-in token means any workflow there can bypass a ruleset on `main`. The key is held by the frontier sync, forge-dispatch and the pull deploy, and forge-dispatch's runner serves requests from the sandbox (ADR-0107).

- Option 1: Keep one App and accept its key as the path to root on the box.
- Option 2: A second operator-owned App, used only by the pull deploy, installed only on the operator repository with Contents: read and Actions: write. The forge App is uninstalled from the operator repository.
- Option 3: The pull deploy reads through a deploy key, which still leaves `forge-bump`'s dispatch needing an App.

## Decision

We will go with Option 2. Its id and private key are `github_box_app_id` and `github_box_app_private_key` in the operator's sops secrets, given only to the pull deploy.

## Consequences

A leaked forge App key reaches the managed repositories, bounded by ADR-0105's rules, but not the operator repository or root on the box. A leaked box App key can read the operator repository and start `forge-bump`, which runs only `main`'s own code. Operators create and install two Apps instead of one, and existing boxes must add the box App's secrets before the pull deploy runs again.
