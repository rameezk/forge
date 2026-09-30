# Forge Operator

This repository was scaffolded from [forge](https://github.com/rameezk/forge)'s
flake template.

## In-environment commands

This repository self-loads its environment: entering the directory with
[direnv](https://direnv.net) active auto-activates the dev shell, putting the
whole standup toolchain on your path. Run `direnv allow` once to opt in.

Every command below is written in that in-environment form. If you do not use
direnv, run each one through `nix develop -c <command>` instead; nothing here
depends on the auto-activation.

## First run

1. Fill in your config:

   ```bash
   cp config.example.json config.json
   $EDITOR config.json
   ```

   Set `sshPublicKeys` to your own key and `hostname`, `serverType`, and
   `location` to your box. The build fails if `config.json` is missing or still
   holds the example placeholder key - there is no silent fallback.

2. Track your files in git and enter the dev shell, which puts `sops`, `age`
   and the rest of the toolchain on your path. The flake evaluates only
   git-tracked files, so `config.json` is invisible until it is staged:

   ```bash
   git init
   git add -A
   direnv allow
   ```

3. Set up your secrets. They live sops-encrypted in `secrets/`, committed next
   to your config. `.sops.yaml` scopes who can read each file:
   `secrets/operator.yaml`, your Hetzner Cloud API token, and
   `secrets/host.yaml`, the box's SSH host key, are for you only, and
   `secrets/runtime.yaml`, the OpenRouter key, is for you and the box.

   1. Create your age key at the sops default location, which is
      `$XDG_CONFIG_HOME/sops/age/keys.txt` when that is set, and otherwise
      `~/.config/sops/age/keys.txt` on Linux and
      `~/Library/Application Support/sops/age/keys.txt` on macOS. Back it up
      somewhere safe: losing it means regenerating every secret, the box's
      host key included.

      ```bash
      key_dir="${XDG_CONFIG_HOME:-$HOME/.config}/sops/age"
      [ "$(uname)" = Darwin ] && [ -z "${XDG_CONFIG_HOME:-}" ] &&
        key_dir="$HOME/Library/Application Support/sops/age"
      mkdir -p "$key_dir"
      age-keygen -o "$key_dir/keys.txt"
      ```

   2. Generate the box's host key pair in a scratch directory and print its
      age recipient:

      ```bash
      host_key_dir="$(mktemp -d)"
      ssh-keygen -q -t ed25519 -N "" -C "" -f "$host_key_dir/host_key"
      ssh-to-age <"$host_key_dir/host_key.pub"
      ```

   3. Fill in the recipients in `.sops.yaml`: replace
      `REPLACE_WITH_OPERATOR_AGE_PUBLIC_KEY` with the output of
      `age-keygen -y "$key_dir/keys.txt"`, and `REPLACE_WITH_BOX_AGE_RECIPIENT` with
      the recipient printed above.

   4. Create the secrets files, delete the scratch copy of the host key, and
      stage them. `sops edit` opens a new file with example content; replace
      it with `HCLOUD_TOKEN: <your Hetzner Cloud API token>` in
      `secrets/operator.yaml`, and with
      `openrouter_api_key: <your OpenRouter key>` in `secrets/runtime.yaml`:

      ```bash
      mkdir -p secrets
      jq -Rs '{ssh_host_ed25519_key: .}' "$host_key_dir/host_key" |
        sops encrypt --filename-override secrets/host.yaml --input-type json --output-type yaml --output secrets/host.yaml /dev/stdin
      rm -rf "$host_key_dir"
      sops edit secrets/operator.yaml
      sops edit secrets/runtime.yaml
      git add -A
      ```

   The build fails if `secrets/runtime.yaml` is missing or `.sops.yaml` still
   holds the placeholder recipients.

4. Run the divergence guard (no cloud access required):

   ```bash
   bash tests/divergence-guard.sh
   ```

   It builds the host, plans the OpenTofu root, and asserts that the built
   host's authorized keys, the planned SSH key, and `config.json` are all
   byte-identical.

## Standup, deploy, and teardown

A box has three commands. Standup and teardown each ask for confirmation before
they create or destroy anything. Deploy changes only the box's NixOS
configuration and runs without a prompt.

| Command         | What it does                                   | Box state                 |
| --------------- | ---------------------------------------------- | ------------------------- |
| `just standup`  | Creates a fresh box and installs forge onto it | Lost - the disk is wiped  |
| `just deploy`   | Applies a changed config to the stood-up box   | Kept                      |
| `just teardown` | Destroys the box                               | Lost - the server is gone |

Each OpenTofu call runs through `sops exec-env` on `secrets/operator.yaml`, so
your Hetzner token is decrypted only for that call and never sits in your shell.

Box state is the run store, frontier snapshot and transcripts under
`/var/lib/forge`, and the GitHub token file `/var/lib/forge/github.env`. Only
deploy keeps it. The OpenRouter key is not box state: the box decrypts it from
this repository on every standup and deploy.

1. Stand the box up:

   ```bash
   just standup
   ```

   Standup decrypts the box's host key from `secrets/host.yaml` and installs
   it, so the box decrypts its runtime secrets on first boot with no manual
   step. If the host key cannot be decrypted, standup stops before creating
   anything.

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

   Here and below, `forge` is the default `adminUser` and SSH runs on the
   default port 22. If you changed `adminUser` or `sshPort` in `config.json`,
   use `ssh -p <sshPort> <adminUser>@<address>` instead.

3. Place the GitHub token if you declare managed repositories. The frontier
   poller reads each managed repository's issues with a fine-grained personal
   access token that is read-only on Issues and Metadata for those
   repositories. Workloads run as the same `forge-runtime` user and can read
   it, so give it a short expiry. You place it by hand after **every** standup,
   into `/var/lib/forge/github.env`. Until it is there, the Work page shows
   "GitHub token missing" on every repository:

   ```bash
   printf 'GitHub token: ' && read -rs token && echo && [ -n "$token" ] &&
     printf 'GITHUB_TOKEN=%s\n' "$token" |
     ssh forge@<address> 'sudo -u forge-runtime sh -c "umask 077 && rm -f /var/lib/forge/github.env && cat > /var/lib/forge/github.env"'; unset token
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

## Rotating the OpenRouter key

Edit the key with sops, commit, and deploy. The next workload uses the new
key. Then revoke the old key in OpenRouter: every earlier version stays
decryptable in git history.

```bash
sops edit secrets/runtime.yaml
git commit -am "chore: rotate the OpenRouter key"
just deploy
```

## Managed repositories

Declare the repositories forge manages in the same `mkHost` modules as your
workers, each keyed by a short name and naming its GitHub `owner/name`. Their
tickets must be tracked as GitHub issues:

```nix
forge.runtime.repositories.forge.github = "rameezk/forge";
forge.runtime.frontier.pollInterval = "5min";
```

A timer then polls each repository's frontier - its open issues labelled
`ready-for-agent` with no open blockers - every `pollInterval`, and the
dashboard's Work page shows it.

To see the frontier live, without waiting for the next poll, run
`forge-frontier list` on the box as the `forge-runtime` user. It queries GitHub
with the same token and writes nothing:

```bash
ssh forge@<address> sudo -u forge-runtime forge-frontier list
```

## Inspecting the run store

Runs, their generations and billed cost live in the SQLite store
`/var/lib/forge/forge.db`. To inspect them:

```bash
ssh forge@<address> sudo -u forge-runtime sqlite3 -readonly /var/lib/forge/forge.db \
  "'select id, status, cost_status, cost_usd from runs order by start_time desc limit 5'"
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
