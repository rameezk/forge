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
The thinking level a worker asks its model for, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, or unset. Unset means the model's own default: forge asks for no level at all, and records the effort as absent, shown as `default`, never as the level the model happened to use (ADR-0038).
_Avoid_: thinking level, reasoning level

**Harness**:
The agent runtime that executes a workload's task (for example `pi` or Claude Code). Forge's config surface is harness agnostic - harnesses are declared by name behind a common contract - though the runner currently implements only the `pi` harness. Each harness's own CLI and event format belongs to its adapter in the runner, not to operator config (ADR-0008).

**Workload toolset**:
The generic command-line tools forge puts on every workload's `PATH`, after its repository's devShell. Forge ships a base set, and operators may extend or replace it. A repository's own stack, a browser included, belongs in its devShell, not here. It is a convenience, not a limit: the workload sandbox exposes the Nix store and the nix daemon, so a workload can run anything in the store (ADR-0024, ADR-0027).
_Avoid_: base image, tool path

**Run directory**:
The per-workload working directory a harness runs in, kept after the run as an artifact until it ages out.
_Avoid_: workdir, sandbox

**Workload sandbox**:
The bubblewrap sandbox a workload's harness and its subagents run in: the Nix store and system files read-only, the run directory read-write, a throwaway `/tmp` and HOME, and no view of the state directory (bar the run's pi agent dir, read-only), the secrets or any other process. The harness holds only the credentials the runner deliberately puts in its environment (ADR-0024).
_Avoid_: container, jail

**Generation**:
One model response within a workload, its subagents' included, identified by OpenRouter's generation id; billed cost is looked up and settled one generation at a time. The store also keeps a given-up row with no id where a response used tokens without one, or where a workload never ended and later generations may be unrecorded.
_Avoid_: response, completion, call

**Billed cost**:
What OpenRouter charged for a workload's generations; a harness's own price estimate is never recorded or shown (ADR-0013). While the cost status is pending, it is what has been billed so far (ADR-0028).
_Avoid_: catalog cost

**Estimated cost**:
Forge's own price for a generation OpenRouter has not billed yet: the harness's token counts at OpenRouter's list price for the model, recorded at run start. Replaced by the billed cost once known, and always shown as estimated (ADR-0032).
_Avoid_: harness cost, pi cost

**Config fingerprint**:
The behaviour-relevant config a workload ran under, recorded at its start as a snapshot with a hash over it: model, reasoning effort, harness extra args, harness version, and hashes of the prompt template, system prompt, tool definitions and skill files. Forge's git sha and the base commit are recorded beside it, not in it (ADR-0034).
_Avoid_: version, run config

**Cohort**:
The workloads sharing one config fingerprint, compared as a group against other cohorts. Workloads recorded before fingerprints existed form the unknown-config cohort (ADR-0034).
_Avoid_: variant, experiment, arm

**Cost status**:
How settled a workload's billed cost is: `pending` until the workload ends and every generation is billed, `billed` once it has, `unconfirmed` once forge gave up on any generation, including on an interrupted workload, where later generations may be unrecorded (ADR-0031).
_Avoid_: cost uncertain

**Interrupted**:
The end state of a workload whose runner stopped heartbeating before finishing it, for example because its unit was killed; distinct from `error`, where the harness itself ended the workload with an error (ADR-0031).
_Avoid_: crashed, stuck, abandoned

**Budget**:
The most a workload may spend in USD, its subagents included, measured as billed cost where known and estimated cost otherwise; set per worker over a global default (ADR-0045).
_Avoid_: cost cap, spend limit

**Exceeded**:
The end state of a workload forge stopped because it crossed its cost budget or its timeout, recording which one; distinct from `error` and `interrupted` (ADR-0044).
_Avoid_: timed out, over budget, killed

**Subagent**:
A child harness run that a workload's agent spawns mid-run to perform a delegated task and report back; it is part of the spawning workload, never a workload of its own (ADR-0009).
_Avoid_: child workload, sub-workload

**Skill load**:
A workload's agent taking in one skill within one scope - the workload itself or one subagent - either through the worker's starting `/skill` prompt or by reading the skill's listed `SKILL.md`, counted once per scope however many reads it took. Its coverage is how much of the file those reads spanned, so a load may be partial. A subagent's kind is the skills it loaded (ADR-0037).
_Avoid_: skill invocation, skill call, skill use

**Managed repository**:
A repository forge is configured to run workloads against, carrying its own skills that orchestrate the work. Operators declare managed repositories in the runtime config; forge currently supports only those whose tickets are tracked as GitHub issues (ADR-0010).

**Ticket**:
A unit of buildable work in a managed repository's tracker, sliced from a spec and carrying a status (`ready-for-agent`, `ready-for-human`, or done) and blocking edges to other tickets. On GitHub, a ticket is an issue: its status is a label, done means closed, and its edges are native issue dependencies.
_Avoid_: issue (the tracker's container, not the concept), job, task

**Frontier**:
The set of tickets that can be picked up now: open, marked ready, and with no open blockers. Forge's frontier is the agent frontier - frontier tickets labelled `ready-for-agent` - since forge cannot act on `ready-for-human` work.
_Avoid_: backlog, queue

**Dispatch**:
Forge picking up a frontier ticket that carries the `forge:ready` label and running a workload against it; the ticket's `forge:*` label tracks the dispatch from claim to outcome (ADR-0016).
_Avoid_: assignment, scheduling

**Rework**:
The commits on a dispatch's pull request authored by anyone other than forge's git identity (ADR-0026), counted each time forge refreshes the pull request until it is merged or closed.

**Queued**:
A `ready-for-agent` ticket labelled `forge:ready` that still has open blockers, so it is not yet on the frontier. Forge's frontier snapshot keeps it beside the frontier, the Work page shows it as queued, and the first sync after its last blocker closes dispatches it.
_Avoid_: pending, waiting

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
