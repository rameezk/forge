# Forge

Shared language for forge, a declarative software factory that runs agent workloads in isolation across multiple repositories.

## Language

**Forge**:
The software factory itself: the declarative control plane and the runtime that stands up infrastructure and runs agent workloads against managed repositories.

**Control plane**:
The declarative layer that defines what infrastructure exists and what workloads may run, as opposed to the execution of any individual workload.

**Workload**:
A single isolated agent run: one harness invoked against one managed repository to perform one task, produced and torn down as a unit.
_Avoid_: job, task (reserve "task" for the work a workload performs).

**Harness**:
The agent runtime that executes a workload's task (for example Claude Code). Forge is harness agnostic: harnesses are pluggable behind a common contract.

**Managed repository**:
A repository forge is configured to run workloads against, carrying its own skills that orchestrate the work.

**Operator**:
A person who stands up and runs their own forge deployment - the reuser of forge, distinct from its author.

**Operator repository**:
A per-operator repository, scaffolded from forge's flake template, that commits the operator's own `config.json` and consumes forge as a flake input to stand up their box. Keeps forge itself generic and secret-free.
