# 0029. The GitHub tokens come from sops

## Status

Accepted

Amends ADR-0017. Refines ADR-0025.

## Context

ADR-0011 put every credential in the operator's sops secrets, but the frontier's read-only token (ADR-0010) and the write token (ADR-0017) are still placed by hand after every standup. The frontier token sits in plain text in `/var/lib/forge/github.env`, where every workload can read it. The write token sits in `/var/lib/forge-credentials/github-write.env`, which ADR-0025 keeps outside run-writable state and reads only as data.

- Option 1: Keep placing both tokens by hand. Every standup needs a manual step, and a forgotten token only shows up at runtime as "GitHub token missing".
- Option 2: Add `github_token` and `github_write_token` to the operator's runtime secrets file. sops renders each into its own `GITHUB_TOKEN=<token>` file under `/run/secrets`, owned by `forge-runtime` with mode 0400 and masked from the units that never use it. The frontier sync loads the frontier token as an EnvironmentFile, like the OpenRouter key. The write token stays data, as ADR-0025 decided: the dispatch and frontier sync units read only `GITHUB_TOKEN` from it.
- Option 3: As Option 2, but load the write token as an EnvironmentFile, since sops now writes the file. The token would then be in every process the dispatch unit starts, not only the agent, and a token value holding a newline could still set other variables.

## Decision

We will go with Option 2. A host with a managed repository needs `github_token`, and a host whose repository declares a worker also needs `github_write_token`. sops-nix refuses to build a host whose secrets file lacks a key it needs, and names the key. tmpfiles deletes a leftover `/var/lib/forge/github.env` and `/var/lib/forge-credentials` on every activation, so no hand-placed token is left behind.

## Consequences

Standup needs no manual step, and the tokens are versioned in git, encrypted, next to the OpenRouter key. Rotating a token is a sops edit and a deploy. The write token must cover every declared repository, because each frontier sync ensures the `forge:*` labels on all of them. The frontier token is masked from the scheduled runner, dispatch and billing, and the write token from the scheduled runner and billing. The dashboard cannot see `/run/secrets` at all. Every unit still runs as `forge-runtime`, so until ADR-0024's confinement is built, a scheduled run can read either token through `/proc` of a frontier sync or a dispatch.
