# 0012. A pre-generated, sops-encrypted SSH host key as the box's identity

## Status

Accepted

## Context

sops-nix (ADR-0011) needs the box to hold a decryption identity from first boot, but every standup installs a fresh, random SSH host key (ADR-0007).

- Option 1: Pre-generate an ed25519 host key, commit it sops-encrypted to the operator only, and inject it at standup through nixos-anywhere `--extra-files`. sops-nix derives the box's age identity from it, and the host key becomes stable across reinstalls.
- Option 2: Inject a dedicated age key the same way, leaving the host key random. Two identities, and the `known_hosts` churn remains.
- Option 3: Keep the random host key and re-encrypt to it after each standup. A two-phase standup and a commit on every reinstall.

## Decision

We will go with Option 1. The operator repository holds three sops files with path-scoped recipients: `secrets/operator.yaml` (Hetzner token) and `secrets/host.yaml` (host private key) for the operator only, and `secrets/runtime.yaml` (box runtime secrets) for the operator and the box.

## Consequences

One identity serves SSH and secrets, and reinstalls keep the same host key. The operator's age key now unlocks the box's host identity too, so losing it means regenerating both. The box can never decrypt the Hetzner token or its own host key file.
