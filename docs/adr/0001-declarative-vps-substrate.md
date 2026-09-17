# 0001. Declarative VPS substrate: OpenTofu provisions, Nix configures

## Status

Accepted

## Context

Forge must stand up its infrastructure declaratively, starting with a single VPS. The first slice is narrow: declaratively stand up a VM reachable by SSH with the owner's key, with no agent runtime yet. "Everything declarative" is a stated goal, weighed against not building machinery a single VPS does not yet need.

Nix can declaratively partition disks (disko), install and own the OS (nixos-anywhere, nixos-rebuild), and deploy updates. What Nix cannot do natively is call a cloud provider's API to make the server resource exist and reconcile its lifecycle against state. That one gap drives the choice.

- Option 1: Pure Nix, create the server by hand. Nix owns everything after a one-time manual create. Simplest, but the "server exists" fact lives outside the repo, so it is not fully declarative.
- Option 2: NixOps. Nix-native tool that both creates cloud machines and deploys NixOS. Single language, but its cloud backends (Hetzner especially) are unevenly maintained, trading tool robustness for purity.
- Option 3: OpenTofu creates the server (plain HCL), Nix installs and owns the OS via disko + nixos-anywhere. Two languages, each the standard for its layer; well-trodden, robust; fully declarative end to end.
- Option 4: Terraform instead of OpenTofu for Option 3. Functionally identical, but BSL-licensed (source-available, not open source) and marked unfree in nixpkgs, which taints an otherwise all-free Nix closure.

## Decision

We will go with Option 3: OpenTofu provisions the Hetzner Cloud server in plain HCL, and Nix (disko + nixos-anywhere, from a flake with the owner's SSH public key) installs and owns the OS. Plain HCL over terranix keeps the create step in the standard language for an eventual provider switch. OpenTofu over Terraform (rejecting Option 4) keeps the toolchain open source and the Nix closure free. NixOps (Option 2) is rejected for tool risk; pure-manual create (Option 1) is rejected because standing up the VM is the slice's whole point.

## Consequences

The full path from nothing to an SSH-reachable NixOS box is declarative and reproducible: destroy and recreate identically. The Hetzner API token is provided at provision time via a gitignored `.env` loaded by direnv, never committed; OpenTofu state is kept local and gitignored. The cost is two tools and two languages rather than one. Provider lock-in is contained to a small HCL file. Server-side secret management (sops-nix or agenix) and the agent-workload runtime are deferred to later slices.
