# Forge

> A declarative software factory.

OpenTofu provisions the Hetzner Cloud server (plain HCL); Nix installs and owns the OS (disko for disk layout, nixos-anywhere to install NixOS from the flake).

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

A single per-host `config.json` is read natively by both OpenTofu and Nix. It carries three tiers: values you must set, values that default but can be overridden, and internal wiring kept in the Nix and HCL sources rather than exposed in config. See `infra/config.example.json` for the full set.

`config.json`, the `.env` holding the Hetzner API token, and OpenTofu state are all kept out of version control. `config.example.json` and `.env.example` ship as placeholders.

## Setup

```sh
cp infra/config.example.json infra/config.json
cp .env.example .env
direnv allow
```

## Checks

The definition is proven without touching any cloud:

```sh
nix flake check
( cd infra/opentofu && tofu init && tofu test )
bash tests/repo-generic.sh
```

`nix flake check` evaluates and instantiates the host configuration; building the full NixOS system closure (`nixosConfigurations.<host>.config.system.build.toplevel`) requires a Linux builder, so on a non-Linux host it is exercised by evaluation and instantiation rather than a full build.
