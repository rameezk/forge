# 0026. A dispatched agent's git environment is set through environment variables

## Status

Accepted

Builds on ADR-0017.

## Context

ADR-0017 puts the write token in the agent's environment as `GITHUB_TOKEN` so the repository's skills can push and open pull requests. git ignores that variable, and the agent has no commit identity: its HOME holds no gitconfig, and under ADR-0024 it becomes a throwaway tmpfs.

For credentials:

- Option 1: `gh auth setup-git`, which writes a credential helper into `~/.gitconfig`. It is lost with ADR-0024's tmpfs HOME, and it is the dotfile planting ADR-0024 exists to stop.
- Option 2: The token embedded in the remote URL. It lands in the checkout's `.git/config`, which is kept as the run's artifact.
- Option 3: The runner sets a credential helper for `https://github.com` through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`. The helper answers with `GITHUB_TOKEN`, and the clone uses the same setup.

For identity:

- Option A: An operator option, `forge.runtime.dispatch.gitIdentity`, with a name and an email.
- Option B: Derived from the token's owner through `GET /user` and their noreply email. Nothing to configure, but each dispatch makes another GitHub call that can fail.
- Option C: A fixed `forge` identity. It marks agent work, but it is not linked to any GitHub account and cannot be changed.

## Decision

We will go with Option 3 and Option A. The runner sets the identity through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. Evaluation fails if a repository declares a worker without `gitIdentity`. `gh` joins the base toolset, and it reads `GITHUB_TOKEN` itself. Only dispatched workloads get any of this. Scheduled workloads have no checkout and no token.

## Consequences

Nothing about the agent's git setup lives in a file, so it works the same inside and outside ADR-0024's sandbox, and it leaves nothing behind for a later run. Commits carry the identity the operator chose, while pushes and pull requests show as the owner of the token. Scheduled workloads have `gh` on their path but no credentials.
