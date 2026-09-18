# Forge

> A declarative software factory.

Forge is a reusable library for standing up a declarative VPS. OpenTofu provisions the Hetzner Cloud server (plain HCL); Nix installs and owns the OS (disko for disk layout, nixos-anywhere to install NixOS from the flake). Forge itself declares no host and holds no operator-specific values: an operator consumes it as a flake input from a separate operator repository that commits its own `config.json` (see ADR-0003).

## Layout

```
flake.nix                     Nix entry point: dev shell and the forge library (lib.mkHost, lib.loadConfig)
infra/
  config.example.json         Example configuration with placeholders
  lib/load-config.nix         Reads a config file and applies defaults
  nixos/                       Host NixOS module and disko disk layout
  opentofu/                    Hetzner Cloud server module (plain HCL) and plan tests
tests/repo-generic.sh         Asserts forge stays generic: no concrete host, no committed secrets
```

## Library

`lib.mkHost { configFile = ./config.json; }` builds a NixOS host from a config file, composing the host NixOS module and disko layout. `lib.loadConfig` reads a config file and applies the defaults. Forge exposes its OpenTofu root as a consumable module with an explicit variable interface. An operator repository consumes forge as a flake input, commits its real `config.json`, and declares its own host through `lib.mkHost`.

## Configuration

A single per-host `config.json` is read natively by both OpenTofu and Nix. It carries three tiers: values you must set, values that default but can be overridden, and internal wiring kept in the Nix and HCL sources rather than exposed in config. See `infra/config.example.json` for the full set.

Forge ships only `config.example.json`; a real `config.json`, the `.env` holding the Hetzner API token, and OpenTofu state all stay out of version control and live in the operator repository.

## Checks

The library is proven without touching any cloud:

```sh
nix flake check
( cd infra/opentofu && tofu init && tofu test )
bash tests/repo-generic.sh
```

`nix flake check` builds an example host through `lib.mkHost` from `config.example.json` and asserts it reflects the example values; building the full NixOS system closure (`config.system.build.toplevel`) requires a Linux builder, so on a non-Linux host it is exercised by evaluation and instantiation rather than a full build. `tofu test` plans the OpenTofu module from the example values, and `tests/repo-generic.sh` asserts forge declares no host and keeps secrets out of git.
