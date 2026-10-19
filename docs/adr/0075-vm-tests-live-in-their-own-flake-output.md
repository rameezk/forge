# 0075. VM tests live in their own flake output

## Status

Accepted

## Context

`checks.<system>` holds both the NixOS VM tests and every other check. Nix has no way to tell `nix flake check` to skip some checks, so `scripts/checks.sh` splits them by evaluating every check and reading `requiredSystemFeatures` from each derivation. A PR run therefore evaluates the flake in full several times: `nix flake check --no-build`, then `checks.sh` in `check-no-vm`, then `checks.sh list` in the `vm-tests` job, which instantiates every NixOS system just to print seven names. That redundant evaluation is most of PR CI time (#401).

- Option 1: Keep VM tests in `checks` and only remove the evaluations that are clearly redundant. At least two full evaluations remain, because the VM/no-VM split still has to inspect every derivation.
- Option 2: Move the VM tests to their own output, `vmTests.<system>`. `nix flake check` then covers exactly the non-VM checks in one evaluation, and VM test names come from the attribute names without instantiating anything. `nix flake check` warns about an unknown output and no longer runs the VM tests by itself.

## Decision

We will go with Option 2. VM tests live under `vmTests.<system>`. CI's `check-no-vm` runs a single `nix flake check`. The `vm-tests` job lists names with `nix eval .#vmTests.x86_64-linux --apply builtins.attrNames`, and each matrix job runs `nix build .#vmTests.x86_64-linux.<test>`. On Darwin, `make check` builds `vmTests.aarch64-linux` directly. `scripts/checks.sh` and `tests/check-selection.sh` go away.

CI still runs every VM test on every PR, and the required `ci` check still gates main, so ADR-0036, ADR-0042 and ADR-0064 keep their meaning. Which work reruns is decided by Nix derivation hashing and the binary cache, never by a hand-written map from paths to checks.

## Consequences

PR CI evaluates the flake once for the non-VM checks, and the VM matrix starts within seconds instead of minutes. `nix flake check` is no longer the whole suite: running a VM test locally means `nix build .#vmTests.<system>.<test>`, and AGENTS.md and the README must say so. The unknown-output warning from `nix flake check` is expected.
