# 0010. Frontier discovery: a polled snapshot in the store, GitHub trackers only

## Status

Accepted

## Context

Forge needs to list the agent frontier across the managed repositories an operator declares. Tickets live in GitHub issues (label status, native issue dependencies), per the operator's skills. The dashboard is read-only over SQLite and is network-locked (`IPAddressDeny = "any"`); only the oneshot runner has outbound network. The box holds no GitHub credential.

- Option 1: A CLI on the box that queries GitHub live. Simple, but the dashboard never shows work and a future dispatch step has nothing stored to read.
- Option 2: The dashboard queries GitHub live. Always fresh, but it relaxes the dashboard's network lockdown and puts a credential in a long-running web process.
- Option 3: A timer-driven poller writes a frontier snapshot into the SQLite store; the dashboard renders it, and a CLI reuses the same query for an on-demand live check.

Separately, the skills also support `local` trackers (tickets as files in the repository), which would need repository checkout to read.

## Decision

We will go with Option 3. Managed repositories are declared as a typed attrset under `forge.runtime` in the operator's flake (ADR-0005/0006), each naming its GitHub `owner/name`. The poller reads GitHub with a read-only fine-grained token placed by hand as an EnvironmentFile, mirroring the OpenRouter key. Only GitHub trackers are supported; `local` trackers are out of scope until dispatch brings repository checkout.

## Consequences

The dashboard stays offline and credential-free, and dispatch can later read the frontier straight from the store. The dashboard's view is only as fresh as the last poll. Operators place a second out-of-band secret after each standup, since server-side secret management stays deferred (ADR-0001). Repositories tracked locally cannot be managed yet.
