# 0007. Install-once standup, with a separate non-destructive deploy

## Status

Accepted

## Context

`just standup` provisions the server and installs NixOS with nixos-anywhere, which always reformats the disk via disko. Re-running it against an installed box cannot work: the hardened host refuses root SSH, and OpenSSH's default `PerSourcePenalties` turns nixos-anywhere's retries into pre-handshake connection resets, so it loops forever. Even if it connected, it would wipe `/var/lib/forge` and the out-of-band OpenRouter key. There was no way to apply a config change, such as a new worker, to a running box.

- Option 1: Declare boxes immutable - every change is teardown then standup, documented. No new tooling, but every worker edit destroys the store, transcripts, and key.
- Option 2: Keep standup install-once and add `just deploy` using `nixos-rebuild switch --target-host --build-host` as the admin user with sudo, building on the box. One extra tool from nixpkgs, NixOS generations for rollback, works from darwin.
- Option 3: Same split, but deploy via deploy-rs. Magic rollback if a deploy breaks SSH, at the cost of a new flake input, a `deploy` output schema, and awkward builds from darwin.
- Option 4: Same split, but deploy via colmena. Built for fleets; more machinery than one box needs.

## Decision

We will go with Option 2. Standup installs a fresh box only and refuses fast, with a pointer to `just deploy` or teardown, when the admin user can already log in. Deploy is NixOS-only: it reads the address from OpenTofu output and never runs `tofu apply`; infrastructure changes stay with standup or teardown then standup. nixos-rebuild joins the shared operator toolchain.

## Consequences

Runtime config changes preserve box state; only teardown loses it. Standup's destructiveness is enforced by the tooling rather than remembered by the operator. A deploy that breaks SSH has no automatic rollback and needs console access to recover. Standup and teardown clear the box's `known_hosts` entry since every install brings a new host key. Server-side secret management stays deferred (ADR-0001), so the OpenRouter key is still placed by hand after each standup.
