# Forge

A declarative software factory. This repository currently holds the substrate: the declarative definition that stands up the single VPS forge runs on.

OpenTofu provisions the Hetzner Cloud server (plain HCL); Nix installs and owns the OS (disko for disk layout, nixos-anywhere to install NixOS from the flake). See [ADR-0001](docs/adr/0001-declarative-vps-substrate.md) and [ADR-0002](docs/adr/0002-configuration-surface-and-source.md).

## Layout

```
flake.nix                     Nix entry point: dev shell + host NixOS configurations
infra/
  config.example.json         Example configuration with placeholders
  lib/load-config.nix         Reads the config file and applies defaults
  nixos/                       Host NixOS module and disko disk layout
  opentofu/                    Hetzner Cloud server definition (plain HCL) and plan tests
tests/repo-generic.sh         Asserts the repo stays generic and secrets stay out of git
```

## Configuration

A single per-host `config.json` is read natively by both OpenTofu and Nix. It carries three tiers:

- **Configurable, no default:** `sshPublicKeys`, `hostname`, `serverType`, `location`.
- **Defaulted, overridable:** `nixosRelease`, `timezone`, `locale`, `sshPort`, `adminUser`, `baseImage`, `arch`, `diskDevice`.
- **Internal wiring:** the disko and nixos-anywhere plumbing, kept in the Nix and HCL sources rather than exposed in config.

`config.json`, the `.env` holding the Hetzner API token, and OpenTofu state are all kept out of version control. `config.example.json` and `.env.example` ship as placeholders.

## Setup

```sh
cp infra/config.example.json infra/config.json   # fill in your own values
cp .env.example .env                              # fill in your Hetzner Cloud API token
direnv allow                                      # loads the dev shell and .env
```

## Checks (no cloud required)

The definition is proven without touching any cloud:

```sh
nix flake check                                   # NixOS configuration reflects config.json
( cd infra/opentofu && tofu init && tofu test )   # OpenTofu plan reflects config.json
bash tests/repo-generic.sh                         # repo stays generic, secrets gitignored
```

`nix flake check` evaluates and instantiates the host configuration; building the full NixOS system closure (`nixosConfigurations.<host>.config.system.build.toplevel`) requires a Linux builder, so on a non-Linux host it is exercised by evaluation and instantiation rather than a full build.

Standing up a real server, SSHing in, and tearing it down is the manual, cost-incurring step, handled separately.
