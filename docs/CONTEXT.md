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
The agent runtime that executes a workload's task (for example `pi` or Claude Code). Forge's config surface is harness agnostic - harnesses are declared by name behind a common contract. Everything harness specific, from its CLI and event format to its per-run state, request capture and skill loads, belongs to its adapter in the runner, not to operator config or the rest of forge (ADR-0008, ADR-0055). A Claude Code run loads the repository's instructions, skills, agents and commands through files forge owns, and none of its settings, hooks or MCP servers, and nothing from the host (ADR-0057, ADR-0097, ADR-0098).

**Workload toolset**:
The generic command-line tools forge puts on every workload's `PATH`, after its repository's devShell. Forge ships a base set, and operators may extend or replace it. A repository's own stack, a browser included, belongs in its devShell, not here. Forge's own `gh`, which carries the GitHub token, is not part of it: it sits in a directory of its own that comes before the devShell too, so no devShell hides it and no operator can remove it (ADR-0073). It is a convenience, not a limit: the workload sandbox exposes the Nix store and the nix daemon, so a workload can run anything in the store (ADR-0024, ADR-0027).
_Avoid_: base image, tool path

**Run directory**:
The per-workload working directory a harness runs in, kept after the run as an artifact until it ages out.
_Avoid_: workdir, sandbox

**Workload sandbox**:
The bubblewrap sandbox a workload's harness and its subagents run in: the Nix store and system files read-only, the run directory read-write, a throwaway `/tmp` and a read-only HOME, and no view of the state directory (bar the run's own agent, config and tmp dirs), the secrets or any other process, the tools sandbox's included. The harness holds only the credentials the runner deliberately puts in its environment (ADR-0024, ADR-0098).
_Avoid_: container, jail

**Tools sandbox**:
The sibling bubblewrap sandbox, one per run, in which every command a workload's agent drives runs, under the repository's devShell. It shares the run directory and the network with the workload sandbox but not its processes, so nothing in it can see or signal the harness (ADR-0098).
_Avoid_: inner sandbox, nested sandbox

**Command broker**:
The process in the tools sandbox that runs each command the harness hands it and reports its output and exit back. The harness reaches the tools sandbox only through it (ADR-0098).
_Avoid_: executor, proxy

**Signal death**:
A harness that ends because a signal killed it, whoever sent it. The run keeps its `error` status and its failed outcome, and its error names the signal and links the tool call in flight when the harness died, if there was one. Forge does not guess the sender, and does not retry the run automatically (ADR-0098).
_Avoid_: crash, killed run

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
The behaviour-relevant config a workload ran under, recorded at its start as a snapshot with a hash over it: model, provider when not `openrouter` (ADR-0048), harness when not `pi`, reasoning effort, harness extra args, harness version, and hashes of the prompt template, system prompt, tool definitions and skill files, plus on Claude Code forge's settings for the run, the repository's skills, agents and commands it loads, and its `AGENTS.md` or `CLAUDE.md`. A workload's own context, such as its ticket or feedback, is never part of it. Forge's git sha and the base commit are recorded beside it, not in it (ADR-0034, ADR-0057, ADR-0095, ADR-0096, ADR-0098).
_Avoid_: version, run config

**Cohort**:
The workloads sharing one config fingerprint, compared as a group against other cohorts. Workloads recorded before fingerprints existed form the unknown-config cohort (ADR-0034).
_Avoid_: variant, experiment, arm

**Active cohort**:
For a worker and repository pair, the cohort of that pair's most recent finished dispatch, revision or conflict resolution, never a manual workload or a diagnosis, so several cohorts can be active at once. It reflects the latest workload, not the config deployed now, because part of the fingerprint is known only once a run starts.
_Avoid_: current cohort, live cohort

**Manual workload**:
A workload an operator started by hand with `forge-run`, as opposed to a dispatch, revision, conflict resolution or diagnosis forge started itself.
_Avoid_: ad hoc run, one-off run

**Previous cohort**:
A cohort that is not active for any worker and repository pair.
_Avoid_: old cohort, inactive cohort, archived cohort

**Cost status**:
How settled a workload's billed cost is: `pending` until the workload ends and every generation is billed, `billed` once it has, `unconfirmed` once forge gave up on any generation, including on an interrupted workload, where later generations may be unrecorded (ADR-0031), or `subscription` for a workload on a subscription provider, which is never billed and never settles (ADR-0047).
_Avoid_: cost uncertain

**Interrupted**:
The end state of a workload whose runner stopped heartbeating before finishing it, for example because its unit was killed; distinct from `error`, where the harness itself ended the workload with an error (ADR-0031).
_Avoid_: crashed, stuck, abandoned

**Setup**:
Forge's preparation of a workload before its harness starts: the clone, its skills and its devShell, and a conflict resolution's trial merge. Bounded by the setup timeout, not the workload's timeout (ADR-0085).
_Avoid_: pre-launch, bootstrap

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

**Review limit**:
The most dispatches forge may have in flight or awaiting review across all managed repositories: its running dispatches plus the open pull requests its App opened for them. At the limit forge starts no new dispatch, though revisions and conflict resolutions still run (ADR-0092).
_Avoid_: WIP limit, PR cap

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

**Acknowledged**:
Feedback carrying a 👀 reaction from forge's GitHub App, meaning forge has seen it and will act on it (ADR-0093, ADR-0099). Being acknowledged never counts as being answered.
_Avoid_: seen, noticed, reacted

**Revision**:
A workload forge runs against a pull request's new feedback, on the pull request's own branch. A pull request may have several (ADR-0050).
_Avoid_: iteration, round, follow-up

**Conflict resolution**:
A workload forge runs on a pull request's own branch when GitHub reports the pull request as conflicting with the default branch, merging the default branch in. A pull request may have several (ADR-0069).
_Avoid_: conflict, resolution, merge-up, rebase

**Quiet period**:
How long a pull request's newest feedback must have gone without more arriving before forge starts a revision for it, set by `forge.runtime.feedback.quietPeriod`. `forge-revise` skips it (ADR-0050).

**Cursor**:
The point in time a pull request's feedback has been consumed up to, set when a revision starts and put back when that revision does not end done (ADR-0070, ADR-0080). Only feedback newer than it can start the next revision, so a failed revision is never retried automatically.

**Outcome**:
Whether a dispatch, revision or conflict resolution landed: `running`, `done` or `failed`, with the reason when it failed (ADR-0080), as opposed to its run's status, which says only whether the harness finished cleanly. The dashboard leads with it, and shows the run's status beside it only when that is not `success` (ADR-0081).
_Avoid_: result, run result

**Diagnosis**:
A workload of the diagnosis worker that explains why a failed dispatch, revision or conflict resolution failed: one cause category, the evidence for it in the failed run's transcript, and one suggested fix. It is shown only on the dashboard, never on GitHub (ADR-0102).
_Avoid_: post-mortem, failure analysis, triage

**Risk grade**:
Jev's judgement of how much careful review one head commit of a forge pull request needs, as a probability for each of four levels (`trivial`, `low`, `moderate`, `high`), its most likely level and a confidence. Below the confidence threshold it is unsettled. A new head makes it stale. It is advice to the reviewer and never changes a dispatch's outcome (ADR-0103).
_Avoid_: risk score, PR score, rating

**Grade outcome**:
What happened to a risk grade's head commit: open until the pull request is merged at that commit (`merged`), receives a new head (`superseded`, with its supersede cause) or is closed unmerged (`closed`), recorded with the number of revisions completed after the grade. It lives in forge's store, the only source a later auto-merge rule reads. A grade is judged over its settled outcomes: a `revision`, `other` or `unknown` supersede counts against it, a `conflict-resolution` supersede is neutral and judges nothing.
_Avoid_: grade result, verdict

**Supersede cause**:
What pushed the head that superseded a risk grade's head commit: a forge revision (`revision`), a forge conflict resolution (`conflict-resolution`), anything else such as a person (`other`), or `unknown` for a supersede recorded before causes were.

**Grading attempt**:
One request to Jev for a head commit that produced no level, recorded with its head commit, time, category and message. The categories are temporary, setup, too large, declined and bug. Temporary, setup and bug attempts are retried on a backoff up to hourly; too large and declined are never retried for that head commit.

**Grading fingerprint**:
What a risk grade was produced under: the configured Jev model and a hash of the question and its level descriptions. Grades sharing one form a grading cohort, compared like workload cohorts but never mixed with them.
_Avoid_: grader version

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
The dashboard's home page: a read-only kanban view of every managed repository's requests and tickets, one swimlane per repository and one column per stage from refinement to done. Its Running column holds every ticket with a live workload, whether a dispatch, a revision or a conflict resolution, ahead of any other column. A person icon marks the columns where a human in the loop acts: refining, building a `ready-for-human` ticket, and reviewing.
_Avoid_: Work page, frontier page, kanban

**Card**:
A request or ticket as the Board shows it, standing for wherever that work is now: the live run while Running, the pull request while In review, the latest attempt's run once Failed, and the issue in every other column or when that run or pull request does not exist.
_Avoid_: tile, item

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

**Forge bump**:
The operator repository's CI job, started by the pull deploy when forge moves, moving its locked `forge` input to forge's latest commit, landing as one commit on its `main` (ADR-0090, ADR-0104).
_Avoid_: forge upgrade, auto-update

**Pull deploy**:
The box deploying its operator repository's `main` to itself whenever `main` moves, so `main` is what the box runs (ADR-0090).
_Avoid_: auto-upgrade, self-deploy

**Template drift**:
The changes forge made to its operator template between the forge commit the operator repository last synced its template copies to and the forge commit it now locks. Surfaced to the operator, never merged automatically.
_Avoid_: template diff, divergence
