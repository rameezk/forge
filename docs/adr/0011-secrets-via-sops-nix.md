# 0011. Secrets via sops-nix, encrypted in the operator repository

## Status

Accepted

## Context

Server-side secret management was deferred (ADR-0001, ADR-0007). The OpenRouter key is piped by hand into `/var/lib/forge/openrouter.env` after every standup, and ADR-0010 adds a GitHub token placed the same way. The Hetzner token lives in a plaintext, gitignored `.env` on the operator's machine. Every standup reinstalls the box, wiping hand-placed secrets.

- Option 1: sops-nix. Secrets are encrypted with age in the operator repository and committed, decrypted on the box at activation into `/run/secrets`, with templates rendering `KEY=value` EnvironmentFiles. One flake input and the `sops` CLI.
- Option 2: agenix. Same model, one file per secret, smaller codebase, no templating.
- Option 3: A password manager as the source of truth, pushed to the box by a `just` recipe after standup. Nothing encrypted in git, but still an imperative step, still lost on teardown, and tied to one vendor's CLI.
- Option 4: systemd-creds bound to a TPM. Not available on Hetzner cloud servers.

## Decision

We will go with Option 1. Every credential - the OpenRouter key, the GitHub token, and the operator-side Hetzner token - lives in sops-encrypted files committed to the operator repository. forge ships the NixOS wiring and stays secret-free (ADR-0003).

## Consequences

Secrets survive standup and deploy with no manual placement, and changes to them are visible in git history. The plaintext `.env` goes away. The operator must hold an age identity, and the box needs a decryption identity that outlives each reinstall's fresh host key. forge gains a sops-nix flake input and the operator toolchain gains `sops`.
