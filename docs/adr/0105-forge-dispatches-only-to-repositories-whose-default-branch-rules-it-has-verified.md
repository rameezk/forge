# 0105. Forge dispatches only to repositories whose default-branch rules it has verified

## Status

Accepted

Amends ADR-0017 and ADR-0049.

## Context

A workload's token can leak, because the sandbox shares the network and a prompt-injected run can send it anywhere. Within its one repository the token holds contents, pull requests, issues, workflows and actions write. GitHub cannot narrow an App token to branches, so only the repository's own rules stop it from landing code on the default branch. ADR-0017 assumed managed repositories protect their default branch, and nothing checks it. On the operator's box, `rameezk/forge`, `rameezk/rebind.koplugin` and `rameezk/unmasked` require 0 approvals and let Actions approve pull requests, so a leaked token can merge its own pull request. For `rameezk/forge`, ADR-0104's bump and the pull deploy then run that commit as root. `rameezk/patient-folio` is private on GitHub Free, which offers neither rulesets nor branch protection on private repositories, so a token can push to its `main`, which deploys to production.

- Option 1: Document the required rules and trust operators to set them.
- Option 2: At every frontier sync, forge reads each managed repository's default-branch rules and refuses to dispatch to one that does not require at least one approving review, approval after the last push, and no bypass for the App, or that lets Actions approve pull requests. A repository whose rules forge cannot read is refused too.
- Option 3: As Option 2, but an operator can accept an unprotected repository.
- Option 4: For a repository without rules, the workload gets no token, and forge pushes and opens the pull request after the run, as ADR-0017's Option 2.

## Decision

We will go with Option 2. Each refusal names the repository and the failing rule, on the dashboard and in the sync log. A private repository needs GitHub Pro on a personal account, or Team on an organisation, for its rules to exist and be readable. The App gains Administration: read, used only by the frontier sync's token, to read whether Actions can approve pull requests.

## Consequences

A leaked workload token cannot put code on a managed repository's default branch without a person's approval, which also closes the path from `rameezk/forge` to root on the box. Operators with private repositories on GitHub Free must upgrade, make them public, or stop managing them. Existing installations must accept Administration: read before any dispatch resumes. A leaked App private key can read every installed repository's administration settings. A rule changed after a sync is caught at the next sync, not mid-run.
