# 0076. CI runs one upstream Nix, pinned to the dev shell's

## Status

Accepted

## Context

CI installed Determinate Nix on the runner, while the dev shell carries nixpkgs' `nix` through `nixos-rebuild-ng`. Mixing the two made a failed build surface as a protocol error, so #520 put Determinate's `nix` first on PATH for `make check-no-vm`. PR CI then went from about 13 minutes to 35-55 minutes: `nix flake check --no-build` alone went from 2:36 to about 18 minutes (#401).

Evaluating `checks.x86_64-linux` locally with each client, same derivations every time:

| Client | Wall | User CPU |
|---|---|---|
| nixpkgs nix 2.34.8 | 2:04 | 2:53 |
| Determinate, `eval-cores = 1` | 2:56 | 17 min |
| Determinate, `eval-cores = 4` | 4:01 | 38 min |
| Determinate, defaults | 4:31-4:51 | 42 min |
| Determinate, `lazy-trees = false` | crashed | - |

- Option 1: Keep Determinate and pin the settings that hurt least. It stays at least 40% slower, burns several times the CPU, and depends on settings that crash in some combinations.
- Option 2: Install upstream Nix on the runner at the same version as the dev shell's `nix`. The daemon and every client run one version, at the cost of moving the pin when nixpkgs' `nix` changes.
- Option 3: Install the latest upstream Nix and accept drift from the dev shell's version. Nothing to maintain, but two versions can meet again.
- Option 4: Go back to the dev shell's `nix` against Determinate's daemon and work around the protocol error another way. Two Nix implementations stay in play.

## Decision

We will go with Option 2. CI installs Nix with `cachix/install-nix-action`, with `install_url` pinned to the release matching the dev shell's `nix`. The runner's `nix` comes first on PATH wherever a job enters the dev shell. A repo test asserts that the pinned version matches the dev shell's `nix --version`, so a nixpkgs bump that moves it fails CI instead of drifting silently.

## Consequences

Evaluation in CI goes back to the speed it had before #520, and a failed build reports its log rather than a protocol error. Every nixpkgs bump that changes `nix` also needs the pin in `ci.yml` moved, which the version test enforces. CI no longer exercises Determinate Nix, which operators may still run locally.
