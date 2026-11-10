# 0091. The box reads its operator repository with the operator's GitHub App

## Status

Accepted

## Context

Under ADR-0090 the box pulls its operator repository's `main`, which is usually private, so the box needs a read credential for it.

- Option 1: Install the operator's GitHub App (ADR-0049) on the operator repository and have the box mint an installation token narrowed to that repository with `contents: read`.
- Option 2: A read-only deploy key held in the runtime secrets.

## Decision

We will go with Option 1. Installing the App on the operator repository does not make it a managed repository, which stays declared in the runtime config.

## Consequences

No new long-lived secret and nothing to rotate. The App's installation now covers a repository forge never dispatches on, so the operator must add it to the installation when enabling the pull.
