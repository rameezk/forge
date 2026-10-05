# 0042. Agents leave the NixOS VM tests to CI

## Status

Accepted

## Context

ADR-0036 made a required CI check run every NixOS VM test for `x86_64-linux`, and had agents on the operator's Mac also run them for `aarch64-linux` on a local Linux builder before pushing. That local run is slow, and it builds for an architecture the box does not run: the deployed box is `x86_64-linux`, which CI already covers. Agents on the box have no KVM and already leave the VM tests to CI. GitHub's hosted arm64 runners have no `/dev/kvm`, so CI cannot take over `aarch64-linux`.

- Option 1: Keep ADR-0036 as is. Agents on the Mac keep `aarch64-linux` coverage at the cost of a slow local run on every change.
- Option 2: Agents everywhere run every check except the VM tests locally and leave the VM tests to CI. When a VM test fails in CI, the agent starts from its log and runs only that test locally if the log does not explain the failure. `aarch64-linux` loses VM-test coverage.
- Option 3: Option 2, plus a self-hosted arm64 runner with KVM to keep `aarch64-linux` coverage in CI. Adds infrastructure and cost for an architecture no box runs.

## Decision

We will go with Option 2. Every NixOS VM test runs for `x86_64-linux` in GitHub Actions on Linux runners with KVM, behind the required `ci` status check on `main`. Agents on any machine run `make check-no-vm` locally and leave the VM tests to CI, and a change is not done until the required checks on its pull request are green. `make check` keeps running or demanding the VM tests for anyone who wants a full local run.

## Consequences

Agents on the Mac finish faster, and agents behave the same on the Mac and on the box. A VM-test failure surfaces only after a push and a CI run. No check runs the VM tests for `aarch64-linux`, although `arch` still accepts it, so an `aarch64-linux` box runs configurations nothing has tested in a VM. Merges still depend on GitHub Actions being available.
