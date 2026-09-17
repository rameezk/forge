# 0003. forge as a library, config lives in a separate operator repository

## Status

Accepted

## Context

ADR-0002 chose a single per-host `config.json`, gitignored, read natively by both OpenTofu and Nix. This does not hold on the Nix side: a flake evaluates only git-tracked files, so a gitignored `config.json` is invisible during evaluation. `builtins.pathExists ./infra/config.json` returns false and the flake silently falls back to `config.example.json`. OpenTofu has no such limit - it reads the file at runtime - so `tofu plan`/`tofu test` and Seam 1 stayed green while the two tools consumed different config. The divergence surfaced only at the first real standup (Seam 2, issue #4): the box authorized the placeholder key and refused SSH.

"Single generic repo + real config gitignored + Nix reads it natively" is therefore unsatisfiable without impurity. One of those pillars must move. Options:

- Option 1: Split. forge becomes a generic library - a host builder (`lib.mkHost`), a reusable OpenTofu module, and a flake template - shipping only `config.example.json`. Each operator keeps a separate repository that commits its own real `config.json` (git-tracked there, so the flake reads it natively) and consumes forge as a flake input. Both tools follow one pattern: forge holds the shared logic, the operator repo is a thin root with real config and local state/secrets.
- Option 2: Template / fork-and-commit. forge stays one repo that operators instantiate and commit config into. Simpler, but copy-once: operators do not get forge improvements without re-merging, and the footgun of an accidental real-config commit into the generic repo remains.
- Option 3: Single repo, impure read (`--impure` + absolute path, or per-invocation `--override-input`). Breaks flake purity, so `nix flake check`/Seam 1 stops being hermetic, and forces exactly the fragile per-invocation flag the design set out to avoid.

## Decision

We will go with Option 1: split into a generic forge library and a per-operator repository.

forge exposes `lib.mkHost` (composing the existing NixOS and disko modules), the OpenTofu root as a reusable module (`source = "github.com/rameezk/forge//infra/opentofu?ref=..."` with an explicit variable interface), and `templates.default` so an operator scaffolds their repo with `nix flake init -t github:rameezk/forge`. The operator repository commits `config.json`, consumes forge as a flake input (`github:` pinned for standups, a `path:` override for local co-development), and keeps `.env` and OpenTofu state gitignored as before.

The silent `pathExists` fallback is deleted, not guarded: forge reads `config.example.json` explicitly, and the operator's `mkHost` reads `./config.json` unconditionally - a missing or placeholder config is a hard evaluation error, never a silent fallback. Seam 1 splits accordingly: forge's own checks build an example host from `config.example.json`, while the operator repository owns the divergence guard - reflect-config checks (built authorized keys and planned SSH key both equal `config.json`) plus one cross-tool assertion that the NixOS toplevel and the OpenTofu plan carry byte-identical keys.

## Consequences

For the first time a real deployment is declared in git - but only in the operator repository, which carries no secrets (`config.json` holds public keys and non-secret infra parameters; the Hetzner token and OpenTofu state stay gitignored there too). forge itself stays generic and secret-free. The cost is two repositories and a cross-repo pin (`?ref=`) to keep in step. The class of bug that shipped is now structurally impossible: config is git-tracked and read unconditionally with no example branch in the operator path, and Seam 1 in the operator repository fails loudly if the two tools ever diverge again. The three-tier config surface and the both-tools-read-one-file principle from ADR-0002 carry forward unchanged; only where that file lives and how forge is consumed have moved.
