# 0112. VM tests go red and green in CI

## Status

Accepted

Builds on ADR-0042 and ADR-0064.

## Context

ADR-0042 left the NixOS VM tests to CI, but let an agent run one locally when a CI log did not explain its failure. AGENTS.md later listed `vmTests` beside the scoped nix checks, and a test-first worker on the box ran `nix build .#vmTests.x86_64-linux.runtime-toolset` as its red step. The box is a Hetzner Cloud vServer with no `/dev/kvm` and no nested virtualisation, yet NixOS advertises the `kvm` system feature by default, so the build crawled under emulation until its 10-minute timeout killed it and the worker stopped. A ticket whose proof is a VM test needs a red and a green the worker has seen.

- Option 1: Give the box KVM, by a dedicated host or a remote KVM builder. ADR-0036 already rejected this for cost and infrastructure.
- Option 2: Run VM tests locally only where KVM exists. Agents behave differently on the Mac and on the box.
- Option 3: Agents never build `vmTests` locally. Red and green come from CI on an early draft pull request: the test change is committed and pushed alone, CI fails on it, then the implementation is pushed and CI passes. A failure the CI log does not explain is answered by making the test report more, not by a local run.
- Option 4: Option 3 without the red run. Faster, but a test that would pass anyway goes unnoticed.

## Decision

We will go with Option 3. A test that can only run in CI goes red and green in CI on the draft pull request, which opens before the reviews and stays a draft until its required checks are green.

## Consequences

Agents behave the same on every machine and never burn a timeout on an emulated VM. A ticket proved by a VM test pays one extra CI cycle for its red run. The red-only commit never reaches `main`, since the repository squash-merges. VM tests have to explain their own failures through their logs.
