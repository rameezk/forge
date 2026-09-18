# Forge

> A declarative software factory.

Forge is a reusable library for standing up a declarative VPS. OpenTofu provisions the Hetzner Cloud server (plain HCL); Nix installs and owns the OS (disko for disk layout, nixos-anywhere to install NixOS from the flake). Forge itself declares no host and holds no operator-specific values: an operator consumes it as a flake input from a separate operator repository that commits its own `config.json` (see ADR-0003).
