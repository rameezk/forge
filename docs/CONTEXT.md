# Forge

Shared language for forge, a declarative software factory that runs agent workloads in isolation across multiple repositories.

## Language

**Forge**:
The software factory itself: the declarative control plane and the runtime that stands up infrastructure and runs agent workloads against managed repositories.

**Control plane**:
The declarative layer that defines what infrastructure exists and what workloads may run, as opposed to the execution of any individual workload.

**Workload**:
A single isolated agent run: one execution of a worker - its harness invoked with the worker's model and prompt - produced and torn down as a unit. Later slices run a workload against a managed repository; the first runtime slice runs the harness with the prompt alone.
_Avoid_: job, task (reserve "task" for the work a workload performs).

**Worker**:
A named, reusable configuration that binds a harness to a model, a prompt, and an optional reasoning effort (for example a `refiner` or a `builder`); one execution of a worker is a workload. Forge declares workers in typed config, each referencing a harness by name, and several workers may share one harness.

**Reasoning effort**:
The thinking level a worker asks its model for, one of the levels its harness takes (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` on `pi`; `low`, `medium`, `high`, `xhigh`, `max` or `ultracode` on Claude Code), or unset. Unset means the model's own default: forge asks for no level at all, and records the effort as absent, shown as `default`, never as the level the model happened to use (ADR-0038).
_Avoid_: thinking level, reasoning level

**Harness**:
The agent runtime that executes a workload's task (for example `pi` or Claude Code). Forge's config surface is harness agnostic - harnesses are declared by name behind a common contract. Everything harness specific, from its CLI and event format to its per-run state, request capture and skill loads, belongs to its adapter in the runner, not to operator config or the rest of forge (ADR-0008, ADR-0055). A Claude Code run loads the repository's own setup natively and nothing from the host (ADR-0057).

**Workload toolset**:
The generic command-line tools forge puts on every workload's `PATH`, after its repository's devShell. Forge ships a base set, and operators may extend or replace it. A repository's own stack, a browser included, belongs in its devShell, not here. Forge's own `gh`, which carries the GitHub token, is not part of it: it sits in a directory of its own that comes before the devShell too, so no devShell hides it and no operator can remove it (ADR-0073). It is a convenience, not a limit: the workload sandbox exposes the Nix store and the nix daemon, so a workload can run anything in the store (ADR-0024, ADR-0027).
_Avoid_: base image, tool path

**Run directory**:
The per-workload working directory a harness runs in, kept after the run as an artifact until it ages out.
_Avoid_: workdir, sandbox

**Workload sandbox**:
The bubblewrap sandbox a workload's harness and its subagents run in: the Nix store and system files read-only, the run directory read-write, a throwaway `/tmp` and HOME, and no view of the state directory (bar the run's pi agent dir, read-only), the secrets or any other process. The harness holds only the credentials the runner deliberately puts in its environment (ADR-0024).
_Avoid_: container, jail

**Generation**:
One billed model call within a workload, its subagents' included, identified by OpenRouter's generation id; billed cost is looked up and settled one generation at a time. Its kind is a `message` from the harness's agent loop, a `compaction` summary, or a `cache_warm` request (ADR-0052). The store also keeps a given-up row with no id where a response used tokens without one, or where a workload never ended and later generations may be unrecorded.
_Avoid_: response, completion, call

**Billed cost**:
What OpenRouter charged for a workload's generations; a harness's own price estimate is never recorded or shown (ADR-0013). While the cost status is pending, it is what has been billed so far (ADR-0028).
_Avoid_: catalog cost

**Estimated cost**:
Forge's own price for a generation OpenRouter has not billed yet: the harness's token counts at OpenRouter's list price for the model, recorded at run start. Replaced by the billed cost once known, and always shown as estimated (ADR-0032).
_Avoid_: harness cost, pi cost

**Provider**:
Where a worker's model is served from: `openrouter`, billed per generation, or `anthropic`, drawn from the operator's Claude subscription. Set per worker, defaulting to `openrouter`; `openrouter` runs only on `pi` and `anthropic` only on Claude Code. A workload's subagents use its provider (ADR-0054).
_Avoid_: backend, vendor

**List-price equivalent**:
What a subscription workload's generations would have cost at the model's list price, from the harness's token counts and OpenRouter's list price for the model. Never billed, and always shown apart from billed and estimated cost (ADR-0047, ADR-0056).
_Avoid_: subscription cost, saved cost

**Config fingerprint**:
The behaviour-relevant config a workload ran under, recorded at its start as a snapshot with a hash over it: model, provider when not `openrouter` (ADR-0048), harness when not `pi`, reasoning effort, harness extra args, harness version, and hashes of the prompt template, system prompt, tool definitions and skill files, plus on Claude Code the repository's Claude Code settings and hooks. Forge's git sha and the base commit are recorded beside it, not in it (ADR-0034, ADR-0057).
_Avoid_: version, run config

**Cohort**:
The workloads sharing one config fingerprint, compared as a group against other cohorts. Workloads recorded before fingerprints existed form the unknown-config cohort (ADR-0034).
_Avoid_: variant, experiment, arm

**Cost status**:
How settled a workload's billed cost is: `pending` until the workload ends and every generation is billed, `billed` once it has, `unconfirmed` once forge gave up on any generation, including on an interrupted workload, where later generations may be unrecorded (ADR-0031), or `subscription` for a workload on a subscription provider, which is never billed and never settles (ADR-0047).
_Avoid_: cost uncertain

**Interrupted**:
The end state of a workload whose runner stopped heartbeating before finishing it, for example because its unit was killed; distinct from `error`, where the harness itself ended the workload with an error (ADR-0031).
_Avoid_: crashed, stuck, abandoned

**Budget**:
The most a workload may spend in USD, its subagents included, measured as billed cost where known and estimated cost otherwise, or as list-price equivalent on a subscription provider; set per worker over a global default (ADR-0045, ADR-0047).
_Avoid_: cost cap, spend limit

**Exceeded**:
The end state of a workload forge stopped because it crossed its cost budget or its timeout, recording which one; distinct from `error` and `interrupted` (ADR-0044).
_Avoid_: timed out, over budget, killed

**Subagent**:
A child harness run that a workload's agent spawns mid-run to perform a delegated task and report back; it is part of the spawning workload, never a workload of its own (ADR-0009).
_Avoid_: child workload, sub-workload

**Narration**:
The short prose a workload's agent and each of its subagents write between tool calls, saying what they are about to do and why, before their first tool call and whenever their plan changes.
_Avoid_: commentary, thinking, status updates

**Skill load**:
A workload's agent taking in one skill within one scope - the workload itself or one subagent - either through the worker's starting `/skill` prompt or by reading the skill's listed `SKILL.md`, counted once per scope however many reads it took. On Claude Code the skill is taken in through its `Skill` tool, which reads the whole file. Its coverage is how much of the file those reads spanned, so a load on `pi` may be partial. A subagent's kind is the skills it loaded (ADR-0037).
_Avoid_: skill invocation, skill call, skill use

**Managed repository**:
A repository forge is configured to run workloads against, carrying its own skills that orchestrate the work. Operators declare managed repositories in the runtime config, naming the worker that runs a repository's tickets with `on.ticket`; forge currently supports only those whose tickets are tracked as GitHub issues (ADR-0010).

**Request**:
Something someone wants done in a managed repository - a feature, a fix or a change - that has not yet been refined into a spec and tickets. On GitHub, a request is an open issue labelled `ready-for-refinement`, a label forge enforces (ADR-0068).
_Avoid_: idea, draft, ticket

**Ticket**:
A unit of buildable work in a managed repository's tracker, sliced from a spec and carrying a status (`ready-for-agent`, `ready-for-human`, or done) and blocking edges to other tickets. On GitHub, a ticket is an issue: its status is a label, done means closed, and its edges are native issue dependencies.
_Avoid_: issue (the tracker's container, not the concept), job, task

**Frontier**:
The set of tickets that can be picked up now: open, marked ready, and with no open blockers. Forge's frontier is the agent frontier - frontier tickets labelled `ready-for-agent` - since forge cannot act on `ready-for-human` work.
_Avoid_: backlog, queue

**Dispatch**:
Forge picking up a frontier ticket that carries the `forge:ready` label and running a workload against it; the ticket's `forge:*` label tracks the dispatch from claim to outcome (ADR-0016). It is done only when its run succeeds and leaves a ready pull request closing the ticket with every required check green, however the repository's skills get there; anything less fails, and forge closes the pull requests its App left for the ticket (ADR-0065, ADR-0066).
_Avoid_: assignment, scheduling

**Approval**:
A maintainer applying `forge:ready` to a ticket, which approves the ticket and its parent spec as they stood at that moment; a ticket is dispatched only while its latest approval stands (ADR-0079).
_Avoid_: sign-off, review

**Attempt**:
A dispatch of a ticket, with the workload it ran. A ticket may have several, one per dispatch.
_Avoid_: try

**Failed start**:
A dispatch, revision or conflict resolution that ended before its harness ran, so it has no run and, for a dispatch, is not an attempt. Consecutive failed starts of the same workload are kept as one, with a count of how many times it failed to start.
_Avoid_: failed attempt, try

**Rework**:
The commits on a dispatch's pull request authored by anyone other than forge's GitHub App (ADR-0051), as of the last time forge refreshed the pull request, which stops once it is merged or closed.

**Maintainer**:
A person whose permission on a managed repository is `write` or `admin`, and so the only kind of person forge takes direction from (ADR-0078).
_Avoid_: trusted user, collaborator, owner

**Feedback**:
The review summaries, inline review comments and conversation comments on a pull request authored by forge's GitHub App, written by a maintainer (ADR-0050, ADR-0078). A review with no body and no inline comments is not feedback.
_Avoid_: review, comments

**Revision**:
A workload forge runs against a pull request's new feedback, on the pull request's own branch. A pull request may have several (ADR-0050).
_Avoid_: iteration, round, follow-up

**Conflict resolution**:
A workload forge runs on a pull request's own branch when GitHub reports the pull request as conflicting with the default branch, merging the default branch in. A pull request may have several (ADR-0069).
_Avoid_: conflict, resolution, merge-up, rebase

**Quiet period**:
How long a pull request's newest feedback must have gone without more arriving before forge starts a revision for it, set by `forge.runtime.feedback.quietPeriod`. `forge-revise` skips it (ADR-0050).

**Cursor**:
The point in time a pull request's feedback has been consumed up to, set when a revision starts and put back when that revision does not end ok (ADR-0070). Only feedback newer than it can start the next revision, so a failed revision is never retried automatically.

**Outcome**:
What a dispatch, revision or conflict resolution achieved, with the reason when it did not succeed, as opposed to its run's status, which says only whether the harness finished cleanly. The dashboard shows the two side by side (ADR-0071).
_Avoid_: result, run result

**Display time zone**:
The time zone the dashboard shows times and days in, set by `forge.runtime.dashboard.timeZone`. Only presentation uses it; the box and everything forge stores stay UTC (ADR-0067).
_Avoid_: timezone, box timezone, local time

**Queued**:
A `ready-for-agent` ticket labelled `forge:ready` that still has open blockers, so it is not yet on the frontier. Forge's frontier snapshot keeps it beside the frontier, the Board shows it as queued in its Blocked column, and the first sync after its last blocker closes dispatches it.
_Avoid_: pending, waiting

**Blocked**:
A ticket with open blockers, whichever status it carries; a queued ticket is the blocked ticket forge will dispatch once its blockers close.
_Avoid_: waiting, held

**Board**:
The dashboard's home page: a read-only kanban view of every managed repository's requests and tickets, one swimlane per repository and one column per stage from refinement to done. A person icon marks the columns where a human in the loop acts: refining, building a `ready-for-human` ticket, and reviewing.
_Avoid_: Work page, frontier page, kanban

**Operator**:
A person who stands up and runs their own forge deployment - the reuser of forge, distinct from its author.

**Operator repository**:
A per-operator repository, scaffolded from forge's flake template, that commits the operator's own `config.json` and consumes forge as a flake input to stand up their box. Keeps forge itself generic and secret-free.

**Operator standup toolchain**:
The single set of tools an operator uses to stand a box up, deploy to it, and tear it down: provision (OpenTofu), install (nixos-anywhere), deploy (nixos-rebuild), the query tool (`jq`), and the command runner (`just`). Forge exports it as one library output (`lib.operatorToolchain`), consumed by both forge's own dev shell and every scaffolded operator repository, so no operator repository can drift to a different toolchain version than forge itself uses. This sharpens the library / operator-repository split (ADR-0003): the split made forge a library exposing the host builder and config loader; exporting the whole standup toolchain from one output widens that same library surface rather than making a new decision.

**Standup**:
The one-time, destructive creation of a box: provisioning the server and installing forge NixOS onto a freshly formatted disk. Valid only against a box that is not yet installed (ADR-0007).
_Avoid_: redeploy, reinstall

**Deploy**:
The non-destructive application of a changed NixOS configuration to an already stood-up box, preserving its state (ADR-0007).
_Avoid_: re-standup, update
