# Forge Operator

This repository was scaffolded from [forge](https://github.com/rameezk/forge)'s
flake template. It holds your real host definition, your committed `config.json`,
and the divergence guard that proves Nix and OpenTofu agree before you spend a
cent. Forge itself stays generic; this repository carries your values.

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

3. Run the divergence guard (no cloud access required):

   ```bash
   bash tests/divergence-guard.sh
   ```

   It builds the host, plans the OpenTofu root, and asserts that the built
   host's authorized keys, the planned SSH key, and `config.json` are all
   byte-identical.

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
