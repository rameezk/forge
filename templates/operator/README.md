# Forge Operator

This repository was scaffolded from [forge](https://github.com/rameezk/forge)'s
flake template.

## In-environment commands

This repository self-loads its environment: entering the directory with
[direnv](https://direnv.net) active auto-activates the dev shell (putting the
whole standup toolchain on your path) and loads your token from `.env`,
tolerating `.env` being absent. Run `direnv allow` once to opt in.

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

## Standup, deploy, and teardown

A box has a three-command lifecycle. Standup and teardown spend or save real
money, so each is its own command - never fused - and pauses for confirmation
before it creates or destroys anything. Deploy changes only the box's NixOS
configuration, so it runs without a prompt.

| Command         | What it does                                   | Box state                 |
| --------------- | ---------------------------------------------- | ------------------------- |
| `just standup`  | Creates a fresh box and installs forge onto it | Lost - the disk is wiped  |
| `just deploy`   | Applies a changed config to the stood-up box   | Kept                      |
| `just teardown` | Destroys the box                               | Lost - the server is gone |

Box state is the run store and transcripts under `/var/lib/forge`, and the
OpenRouter key file `/var/lib/forge/openrouter.env`. Only deploy keeps it.

1. Stand the box up. This provisions the server, reads the provisioned address
   back itself, and installs onto a freshly formatted disk - building on the
   target, so it works even from a machine that cannot build the target's system
   locally:

   ```bash
   just standup
   ```

   Standup only ever creates a fresh box. If your admin user can already log in
   to the box, standup refuses straight away and points you to `just deploy`, or
   to teardown then standup for a fresh box. If an install fails part-way, just
   run standup again.

2. Verify it by hand - confirm the box is reachable over SSH with your
   configured key. Standup clears the box's old host key from your
   `known_hosts`, so this works even when the address was used by an earlier
   box:

   ```bash
   ssh forge@<address>
   ```

3. Place the OpenRouter key. The key is never in the Nix store or this
   repository, so you place it by hand after **every** standup. This prompts for
   the key without echoing it and streams it to `/var/lib/forge/openrouter.env`
   with mode `0600`, keeping it out of your shell history and every command line:

   ```bash
   read -rs key && printf 'OPENROUTER_API_KEY=%s\n' "$key" |
     ssh forge@<address> 'sudo sh -c "umask 077 && cat > /var/lib/forge/openrouter.env"'
   unset key
   ```

4. Deploy config changes, such as a new or edited worker in `flake.nix`. Deploy
   reads the box address from OpenTofu, then runs `nixos-rebuild switch` on the
   box as your admin user, building on the box. It keeps the box's state, and it
   changes only NixOS: it never runs `tofu apply`, so infrastructure changes
   such as `serverType` or `location` still need teardown then standup. The flake
   sees only git-tracked files, so stage a change before deploying it:

   ```bash
   git add -A
   just deploy
   ```

   A deploy that breaks SSH has no automatic rollback; recover it from the
   Hetzner console.

5. Tear the box down when you are done. This loses the box's state and clears
   its host key from your `known_hosts`:

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
