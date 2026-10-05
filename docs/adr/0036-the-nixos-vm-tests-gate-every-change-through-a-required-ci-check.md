# 0036. The NixOS VM tests gate every change through a required CI check

## Status

Superseded by ADR-0042

## Context

The NixOS VM tests need a Linux machine with `/dev/kvm`. The flake defines them only for Linux systems, so `nix flake check` on the operator's Mac leaves them out and passes. Agents report "No Linux builder is available here" and skip them. A dispatched agent on the box cannot run them either, because Hetzner's shared instances have no `/dev/kvm`. The repository has no CI, so the VM tests rarely run before a change merges.

- Option 1: Keep relying on local runs and have agents state prominently that they were skipped. Costs nothing, but coverage still depends on someone having a Linux builder and remembering to use it.
- Option 2: Configure a Linux builder on the Mac only. Agents on the Mac can check their own work, but dispatched agents on the box still cannot, and nothing stops a merge that skipped the tests.
- Option 3: Give the box a builder with KVM, or move it to an instance type with KVM. Every environment can run the tests, but it costs money and adds infrastructure for a check that only needs to happen once per change.
- Option 4: Run the full check suite in GitHub Actions on Linux runners with KVM, and make it a required status check on `main`. Back it up with a Linux builder on the Mac and a separate check target without the VM tests for machines lacking KVM.

## Decision

We will go with Option 4. A GitHub Actions workflow runs everything `make check` covers, including the VM tests for `x86_64-linux`, and is a required status check on PRs to `main`. The operator's Mac gets a Linux builder so agents there run the VM tests for `aarch64-linux` before pushing. `make check` fails when it cannot reach a Linux builder rather than skipping the VM tests. A separate target runs every check except the VM tests, for machines without KVM such as the box. AGENTS.md counts the VM tests as part of "tests pass". An agent that cannot run them must not call a change to anything they cover done until they pass, either locally or in the PR's CI.

## Consequences

A change cannot merge without the VM tests passing on at least one Linux system. Agents on the box rely on CI for that coverage instead of running it themselves. `make check` on a Mac without a Linux builder now fails, so a fresh machine must set one up, or use the target without the VM tests and rely on CI. CI covers only `x86_64-linux`, the architecture the box runs. `aarch64-linux` coverage depends on the local builder. Merges now depend on GitHub Actions being available.
