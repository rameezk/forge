# 0108. A managed repository's Actions secrets live in default-branch environments

## Status

Accepted

## Context

A workload token can push branches, and a push runs the repository's push and pull request workflows over the branch's own scripts, with every repository-level secret those workflows name. An environment secret limited to the default branch reaches only jobs on that branch, which ADR-0105's rules guard.

- Option 1: Make it an operator requirement that a managed repository keeps its Actions secrets only in environments limited to its default branch, unchecked by forge.
- Option 2: Forge refuses at frontier sync a repository with repository-level secrets, which needs the App to gain Secrets: read.
- Option 3: As Option 1, with forge flagging workflows that name secrets outside an environment, by reading workflow files.

## Decision

We will go with Option 1. The requirement sits next to ADR-0105's rules in the operator documentation.

## Consequences

The App gains no permission and a leaked App private key sees no secret names. Forge cannot tell when a repository breaks the requirement, and a token leaked from such a repository can expose its repository-level secrets to a workflow run on a pushed branch.
