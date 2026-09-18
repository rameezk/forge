# Forge

> A declarative software factory.

Forge is a reusable library for standing up a declarative VPS. You do not deploy
forge directly; you scaffold your own operator repository from its flake template
and drive your box from there.

## Get started

Scaffold an operator repository:

```bash
nix flake init -t github:rameezk/forge
```

That gives you a repository that consumes forge as a flake input, holds your real
host definition and a thin OpenTofu root, and ships the divergence guard that
proves Nix and OpenTofu agree before you spend a cent. Fill in its `config.json`,
then follow its README. Your repository carries your values; forge stays generic
and secret-free.

## What forge provides

- `lib.mkHost` - builds a NixOS host from a config file.
- `lib.loadConfig` - reads a config file and applies forge's defaults.
- The OpenTofu module under `infra/opentofu` - provisions the Hetzner server from
  a `config` object, consumed as
  `github.com/rameezk/forge//infra/opentofu?ref=...`.
- `templates.operator` - the operator repository scaffold above.

## Checks

Forge proves its library on example data alone, with no cloud access:

- `nix flake check` builds the example host from `config.example.json`.
- `cd infra/opentofu && tofu test` plans the module from `config.example.json`.
- `bash tests/repo-generic.sh` checks that forge stays generic and declares no concrete host.
- `bash tests/template-scaffold.sh` scaffolds the template and runs its divergence guard.

See `docs/adr/0003-forge-library-operator-repo-split.md` for why forge is a
library and the operator's config lives in a separate repository.
