# 0002. Configuration surface: single shared, gitignored config file

## Status

Accepted

## Context

Forge is meant to be reusable by operators other than its author, so nothing person- or deployment-specific may be a baked-in constant. The substrate spans two tools (OpenTofu and Nix, see ADR-0001), and some values - the SSH authorized keys above all - are needed by both: OpenTofu registers a key with the provider so nixos-anywhere can connect, and the NixOS config bakes keys in for the running system. That shared value should be defined once.

Config values fall into three tiers: configurable with no sane universal default (SSH keys, hostname, server type, location), defaulted-but-overridable (NixOS release, timezone/locale, SSH port, admin user, base image, disk layout), and internal wiring not worth exposing (the disko/nixos-anywhere plumbing).

Two questions were weighed. Where config lives:
- Option 1: One shared `config.json` both tools read natively (Nix `fromJSON`, OpenTofu `jsondecode`). One source of truth, no build step. JSON is the only format both parse without extra machinery.
- Option 2: Nix is the source and a `tfvars.json` is generated from it by `nix eval`. Nicer authoring, but adds a regenerate-before-apply step.
- Option 3: Separate config per tool, accepting the SSH key is written in two places.

Whether the real config is committed:
- Option A: Gitignored `config.json` plus a committed `config.example.json` placeholder. The repo stays generic; each operator's specifics stay local.
- Option B: Commit the real per-host `config.json`. The repo fully declares the deployment in git, but carries one person's specifics; reusers fork and edit.

## Decision

We will go with Option 1 and Option A: a single per-host `config.json`, read directly by both OpenTofu and Nix, kept out of git (gitignored) with a committed `config.example.json` holding placeholders. The three-tier split governs what appears in it. SSH keys are a list of public-key strings (not file paths) so the config is self-contained; the example ships with a placeholder, never a real key.

## Consequences

The SSH key and other shared values are defined once and consumed by both tools with no generation step. Forge stays a generic, reusable tool: an operator copies `config.example.json` to `config.json` and fills in their own values. The cost is that the shared repo does not itself declare any live deployment - the actual config lives only on each operator's machine, alongside the gitignored `.env` and OpenTofu state. `.gitignore` covers `.env`, `.direnv/`, `*.tfstate*`, and `config.json`.
