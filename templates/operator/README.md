# Forge Operator

This repository was scaffolded from [forge](https://github.com/rameezk/forge)'s
flake template.

## In-environment commands

This repository self-loads its environment: entering the directory with
[direnv](https://direnv.net) active auto-activates the dev shell (putting the
whole standup toolchain - `tofu`, `nixos-anywhere`, `jq`, and `just` - on your
path) and loads `HCLOUD_TOKEN` from `.env`, tolerating `.env` being absent. Run
`direnv allow` once to opt in.

Every command below is written in that in-environment form. If you do not use
direnv, run each one through `nix develop -c <command>` instead and export
`HCLOUD_TOKEN` yourself; nothing here depends on the auto-activation.

## First run

1. Fill in your config:

   ```bash
   cp config.example.json config.json
   $EDITOR config.json
   ```

   Set `sshPublicKeys` to your own key and `hostname`, `serverType`, and
   `location` to your box. The build fails loudly if `config.json` is missing or
   still holds the example placeholder key - there is no silent fallback.

2. Copy the environment file and add your token:

   ```bash
   cp .env.example .env
   $EDITOR .env
   ```

3. Track your files in git. The flake evaluates only git-tracked files, so
   `config.json` is invisible until it is staged:

   ```bash
   git init
   git add -A
   direnv allow
   ```

4. Run the divergence guard (no cloud access required):

   ```bash
   bash tests/divergence-guard.sh
   ```

   It builds the host, plans the OpenTofu root, and asserts that the built
   host's authorized keys, the planned SSH key, and `config.json` are all
   byte-identical.

## Standup and teardown

Standup and teardown are two separate commands - never fused - with manual
verification between them, so you keep the live-infrastructure judgment at both
moments that spend real money. Each pauses for confirmation before it creates or
destroys anything.

1. Stand the box up. This provisions the server, reads the provisioned address
   back itself, and installs onto it - building on the target, so it works even
   from a machine that cannot build the target's system locally:

   ```bash
   just standup
   ```

2. Verify it by hand - confirm the box is reachable over SSH with your
   configured key:

   ```bash
   ssh forge@<address>
   ```

3. Tear the box down when you are done:

   ```bash
   just teardown
   ```

## Pinning forge

`flake.nix` consumes forge as `github:rameezk/forge`. Pin it to a specific ref
for reproducible builds:

```bash
nix flake lock --override-input forge github:rameezk/forge/<commit>
```

For co-developing forge and this repository together, override the input with a
local path:

```bash
nix flake check --override-input forge path:/path/to/forge
```

`infra/opentofu/main.tf` pins the same forge ref for the OpenTofu module; keep
the two references in step. To co-develop against a local forge, point the module
`source` at a local path (`../../path/to/forge/infra/opentofu`) and rerun
`tofu init`.
