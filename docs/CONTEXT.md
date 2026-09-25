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

**Harness**:
The agent runtime that executes a workload's task (for example `pi` or Claude Code). Forge's config surface is harness agnostic - harnesses are declared by name behind a common contract - though the runner currently implements only the `pi` harness. Each harness's own CLI and event format belongs to its adapter in the runner, not to operator config (ADR-0008).

**Managed repository**:
A repository forge is configured to run workloads against, carrying its own skills that orchestrate the work.

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
