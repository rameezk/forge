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

3. Set up your tailnet, as [Tailnet setup](#tailnet-setup) describes, and keep
   both OAuth clients' credentials at hand for the next step.

4. Set up your secrets. They live sops-encrypted in `secrets/`, committed next
   to your config. `.sops.yaml` scopes who can read each file:
   `secrets/operator.yaml`, your Hetzner Cloud API token and the Tailscale
   OAuth client that deletes the box's old tailnet device, and
   `secrets/host.yaml`, the box's SSH host key, are for you only, and
   `secrets/runtime.yaml`, the Tailscale OAuth client secret, the OpenRouter
   key and the GitHub tokens, is for you and the box.

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

   4. Pin the box's host key: commit its public key next to the encrypted
      private key, and write a `known_hosts` entry keyed on your `hostname`
      rather than the box's address. Every `just` command that connects to the
      installed box checks against this file, so a reinstall needs no
      `known_hosts` edits and a mismatched key fails the connection. If you
      change `hostname` later, rerun the `printf` line below:

      ```bash
      mkdir -p secrets
      cp "$host_key_dir/host_key.pub" secrets/host.pub
      printf '%s %s\n' "$(jq -r .hostname config.json)" "$(cat secrets/host.pub)" >known_hosts
      ```

   5. Create the secrets files, delete the scratch copy of the host key, and
      stage them. `sops edit` opens a new file with example content; replace
      it with `HCLOUD_TOKEN: <your Hetzner Cloud API token>`,
      `TAILSCALE_OAUTH_CLIENT_ID: <the device-deletion client ID>` and
      `TAILSCALE_OAUTH_CLIENT_SECRET: <the device-deletion client secret>` in
      `secrets/operator.yaml`, and with
      `tailscale_auth_key: <the box's OAuth client secret>` and
      `openrouter_api_key: <your OpenRouter key>` in `secrets/runtime.yaml`.
      If you declare managed repositories, also add their GitHub tokens to
      `secrets/runtime.yaml`, as [GitHub tokens](#github-tokens) describes:

      ```bash
      jq -Rs '{ssh_host_ed25519_key: .}' "$host_key_dir/host_key" |
        sops encrypt --filename-override secrets/host.yaml --input-type json --output-type yaml --output secrets/host.yaml /dev/stdin
      rm -rf "$host_key_dir"
      sops edit secrets/operator.yaml
      sops edit secrets/runtime.yaml
      git add -A
      ```

   The build fails if `secrets/runtime.yaml` is missing, lacks
   `tailscale_auth_key`, or lacks a key your workers or repositories need,
   `.sops.yaml` still holds the placeholder recipients, or `known_hosts` does
   not pin `secrets/host.pub` under your `hostname`.

5. Run the divergence guard (no cloud access required):

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
Deleting the box's old tailnet device does the same with the device-deletion
OAuth client, which is kept from OpenTofu and never reaches the box.

Once the box is installed, your tailnet is the only way in: the box accepts SSH
on `sshPort` over the tailnet only, never from the public internet. Standup
installs over the box's public IP, since the box is not on the tailnet until
its installed system runs, and then reaches the box by its `hostname` on the
tailnet, as `just ssh` and `just deploy` always do. So your machine must be
logged in to the tailnet with MagicDNS on before you run any of them, as
[Tailnet setup](#tailnet-setup) describes.

Box state is the run store, frontier snapshot and transcripts under
`/var/lib/forge`, and the box's tailnet device under `/var/lib/tailscale`. Only
deploy keeps it. The Tailscale OAuth client secret, the OpenRouter key and the
GitHub tokens are not box state: the box decrypts them from this repository on
every standup and deploy, though it uses the Tailscale secret only to join the
tailnet.

1. Stand the box up:

   ```bash
   just standup
   ```

   Standup decrypts the box's host key from `secrets/host.yaml` and installs
   it, so the box decrypts its runtime secrets on first boot with no manual
   step. If the host key cannot be decrypted, standup stops before creating
   anything.

   Standup only ever creates a fresh box. If your admin user can already log in
   to the box, over the tailnet or at its public IP, standup refuses straight
   away and points you to `just deploy`, or to teardown then standup for a fresh
   box. If an install fails part-way, just run standup again.

   Every standup installs onto a clean disk, so the box joins the tailnet as a
   new device. Before installing, standup deletes any `tag:forge` device
   already named after your `hostname`, so the new box keeps that name rather
   than becoming `<hostname>-1`. If that device is still connected to the
   tailnet, it may be your running box, so standup deletes nothing and stops
   before installing, even when it could not log in to the box. It stops the
   same way if the Tailscale API refuses the deletion.

   After the install, standup waits until it can log in to the box over the
   tailnet, and fails, saying the box did not join the tailnet, if that takes
   longer than ten minutes. To wait a different number of seconds, pass it as
   `just tailnet_join_timeout=900 standup`.

2. Verify it by hand - confirm the box is reachable over SSH with your
   configured key:

   ```bash
   just ssh
   ```

   `just ssh` connects to the box by its `hostname` over the tailnet, fills in
   its SSH port and admin user, checks the box against the host key in
   `known_hosts`, and passes any extra arguments on to `ssh`.

3. Deploy config changes, such as a new or edited worker in `flake.nix`. Deploy
   runs `nixos-rebuild switch` on the box over the tailnet as your admin user,
   building on the box. It keeps the box's state, and it
   changes only NixOS: it never runs `tofu apply`, so infrastructure changes
   such as `serverType` or `location` still need teardown then standup. The flake
   sees only git-tracked files, so stage a change before deploying it:

   ```bash
   git add -A
   just deploy
   ```

   A deploy that breaks SSH or Tailscale has no automatic rollback; recover it
   from the Hetzner console.

4. Tear the box down when you are done. This loses the box's state:

   ```bash
   just teardown
   ```

   Once OpenTofu has destroyed the server, teardown deletes the box's device
   from the tailnet too. If OpenTofu had no server to destroy, teardown leaves
   the device alone while it is still connected, since it may be a running box
   that OpenTofu has lost track of.

## Tailnet setup

Every box joins your [Tailscale](https://tailscale.com) tailnet as a device
tagged `tag:forge`, named after the `hostname` in `config.json`, and serves the
dashboard on it at `https://<hostname>.<tailnet>.ts.net`, where `<tailnet>` is
your tailnet's DNS name from the DNS page of the admin console. You set the
tailnet up once, by hand, in the
[Tailscale admin console](https://login.tailscale.com/admin). Forge never
changes your tailnet's policy or its OAuth clients.

1. Let the tailnet hold `tag:forge` devices and let you reach SSH and the
   dashboard on them. In the policy file on the Access controls page, add a
   `tagOwners` entry for `tag:forge` and an access rule for your `sshPort` and
   port 443, merging them into any `tagOwners` and `grants` you already have.
   The rule below uses the default `sshPort` of 22; if you changed it, use
   yours:

   ```json
   {
     "tagOwners": {
       "tag:forge": ["autogroup:admin"]
     },
     "grants": [
       {
         "src": ["autogroup:admin"],
         "dst": ["tag:forge"],
         "ip": ["tcp:22", "tcp:443"]
       }
     ]
   }
   ```

   A new tailnet's policy starts with a grant that lets every device reach
   every other, `{"src": ["*"], "dst": ["*"], "ip": ["*"]}`. Replace it with
   grants for what your own devices need, so that no grant has a `src` that
   matches `tag:forge` and only the grant above reaches it. The box runs
   agents and needs to reach nothing on your tailnet. As a second line, forge
   stops workloads from reaching tailnet addresses and keeps the box off the
   tailnet's DNS. With the grant above, only your tailnet's admins reach the
   box's SSH and dashboard. Anyone you add to its `src` can read every run's
   prompt, transcript and repository data on the dashboard.

2. Turn on MagicDNS and HTTPS certificates. On the DNS page, enable MagicDNS
   if it is off, then select **Enable HTTPS** under HTTPS Certificates. The
   box gets its certificate on the first visit to the dashboard, so that visit
   can take a few seconds. Every certificate is published in the public
   Certificate Transparency logs, so your box's `hostname` and your tailnet's
   DNS name become public.

3. Create the box's OAuth client. On the
   [Trust credentials](https://login.tailscale.com/admin/settings/trust-credentials)
   page, select **Credential**, then **OAuth**. Give it the `auth_keys` scope
   with write access and the `tag:forge` tag, then generate it and copy the
   client secret, which starts with `tskey-client-` and is shown only once.
   The box registers with it as a preauthorized device tagged `tag:forge`
   that is not ephemeral. The secret does not expire, and neither does the
   device's key, since the device is tagged.

4. Add the client secret to `secrets/runtime.yaml` as `tailscale_auth_key`.
   On a first run, the secrets step of [First run](#first-run) does this when
   it creates the file. In a repository that already has the file, add it
   with `sops edit secrets/runtime.yaml` and commit. A box that is not on the
   tailnet yet joins it only through `just teardown` then `just standup`,
   since deploy reaches the box over the tailnet. The build fails, naming the
   key, if it is not there:

   ```yaml
   tailscale_auth_key: <the box's OAuth client secret>
   ```

5. Create the OAuth client that deletes the box's old tailnet device. It is
   yours alone: it stays in `secrets/operator.yaml` and never reaches the box,
   so the box never holds a credential that can delete devices. On the same
   Trust credentials page, select **Credential**, then **OAuth** again. Give it
   the `devices:core` scope with write access and the `tag:forge` tag, which
   Tailscale requires for that scope, then generate it and copy both the client
   ID and the client secret. Forge deletes only a `tag:forge` device named
   after your `hostname` with it.

6. Add both to `secrets/operator.yaml`. On a first run, the secrets step of
   [First run](#first-run) does this when it creates the file. In a repository
   that already has the file, add them with `sops edit secrets/operator.yaml`
   and commit. Standup and teardown fail, naming the keys, if they are missing
   or the Tailscale API rejects them:

   ```yaml
   TAILSCALE_OAUTH_CLIENT_ID: <the device-deletion client ID>
   TAILSCALE_OAUTH_CLIENT_SECRET: <the device-deletion client secret>
   ```

7. Install Tailscale on your own machine from
   [tailscale.com/download](https://tailscale.com/download) and log in to the
   same tailnet as an admin. Once the box is stood up, it appears in the
   admin console's Machines page as `<hostname>`, and the dashboard opens at
   `https://<hostname>.<tailnet>.ts.net`.

Once the box has joined, it no longer uses the client secret, so a changed
`tailscale_auth_key` takes effect only when the box joins again, at the next
standup. It stays decrypted on the box, so if the box or its host key is ever
compromised, revoke the OAuth client on the Trust credentials page and create a
new one. If Tailscale fails on the box, neither SSH nor the dashboard is
reachable until it recovers, and the only way in is the Hetzner console.

## Opening the dashboard

Browse to `https://<hostname>.<tailnet>.ts.net` from a machine on your tailnet,
as [Tailnet setup](#tailnet-setup) describes.

## Rotating a runtime secret

Edit the OpenRouter key, the Anthropic token or a GitHub token with sops, commit, and deploy. The
next workload, frontier sync or dispatch uses the new value. Then revoke the
old one in OpenRouter or GitHub: every earlier version stays decryptable in
git history.

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

### GitHub tokens

Forge reads GitHub with tokens from `secrets/runtime.yaml`. Add them with
`sops edit secrets/runtime.yaml`, commit, and deploy. The build fails, naming
the missing key, if a token your repositories need is not there.

- `github_token`, needed when you declare any managed repository: a
  fine-grained personal access token that is read-only on Issues and Metadata
  for the managed repositories. The frontier sync and `forge-frontier list`
  read the frontier with it.
- `github_write_token`, needed when a repository declares a worker: a
  separate fine-grained personal access token with read and write access on
  Contents, Pull requests, Issues and Workflows. GitHub rejects any push that
  adds or changes a file under `.github/workflows/` from a token without
  Workflows, so a run that sets up CI cannot push. It must cover **every**
  declared repository, not only those with a worker, because each frontier
  sync makes sure all of them have the `forge:*` labels. Forge also uses it
  to move dispatched tickets through those labels, and the dispatched agent
  gets it as `GITHUB_TOKEN`, so the repository's skills can push branches and
  open pull requests. It also needs read-only access on Checks and Actions,
  so the agent can watch a pull request's required checks and read the logs
  of the ones that fail.

```yaml
tailscale_auth_key: <the box's OAuth client secret>
openrouter_api_key: <your OpenRouter key>
github_token: <your read-only GitHub token>
github_write_token: <your GitHub write token>
```

A run can use the write token for anything it allows in every managed
repository, including changing CI workflows, so protect each default branch
and give the token a short expiry.
No forge service can read the decrypted secrets on the box; each gets only
the tokens it uses, from systemd. A workload's agent runs in a sandbox that
sees neither the secrets nor any other process, so it holds only what forge
hands it: the OpenRouter key, and the write token on a dispatch. Treat every
dispatched workload as able to use the write token.

To see the frontier live, without waiting for the next poll, run
`forge-frontier list` on the box as the `forge-runtime` user. It queries GitHub
with the same token and writes nothing:

```bash
just ssh sudo -u forge-runtime forge-frontier list
```

### Dispatching a ticket

Give a repository a worker to run its tickets. The worker's prompt is written
the way you would type it locally, with `{repo}` (the repository's
`owner/name`), `{issue}` (the ticket's number) and `{url}` (its URL) filled in
for each ticket. It must hold `{issue}` or `{url}`, or the host does not
evaluate:

```nix
forge.runtime.workers.builder = {
  harness = "pi";
  model = "z-ai/glm-5";
  prompt = "/work-on {url}";
};
forge.runtime.repositories.forge = {
  github = "rameezk/forge";
  worker = "builder";
};
forge.runtime.dispatch.gitIdentity = {
  name = "Forge";
  email = "forge@example.com";
};
```

A host with a repository that declares a worker must also set
`dispatch.gitIdentity`, or it does not evaluate. Every commit a dispatched
workload makes carries it as author and committer, while pushes and pull
requests show as the owner of the GitHub write token.

Label a ticket `forge:ready` and forge dispatches it by itself. Straight after
every frontier sync, a dispatch pass starts a `forge-dispatch@` unit for each
frontier ticket labelled `forge:ready`, oldest first. A ticket labelled
`forge:ready` that still has open blockers is queued: the Work page shows it as
queued, and the first sync after its last blocker closes dispatches it. So to
queue a whole spec, label all of its tickets.

`forge.runtime.dispatch.maxConcurrent`, 1 by default, limits how many
dispatched workloads run at once across every repository, and tickets from the
same repository may run in parallel. A ticket over the limit stays
`forge:ready` until a pass after one of the running workloads finishes. The
pass may start only `forge-dispatch@` units of repositories that declare a
worker, which polkit allows the forge-runtime user and nothing else.

To dispatch a ticket straight away rather than waiting for the next sync, run:

```bash
just ssh sudo forge-dispatch forge 113
```

Forge refuses a ticket that is not on the frontier or not labelled
`forge:ready`, and refuses to start a workload beyond `maxConcurrent`, however
the ticket was dispatched. Otherwise it claims the ticket by replacing `forge:ready` with
`forge:running`, clones the tip of the repository's default branch into a
fresh run directory and runs the worker there. The clone and the workload
authenticate to `https://github.com` with the write token, through a git
credential helper set only in their environment, so private repositories
clone too, and the agent can push and open pull requests with `gh`. Nothing
is written to the workload's HOME or the checkout's `.git/config`, and
scheduled workers get no identity, helper or token. The workload loads the
checkout's `.claude/skills`, `.agents/skills` and `.pi/skills`, its root
`AGENTS.md` (or `CLAUDE.md`), and `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md`,
and it is told that no human will answer. pi never trusts the checkout, so the
rest of its pi config, `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions`,
`.pi/prompts` and `.pi/themes`, is not loaded, and the run output warns about
each one the checkout has. A leading `/<name>` in the prompt runs the
checkout's skill of that name, and the run fails before the harness starts if
there is none. The Runs page shows the repository and ticket of each
dispatched run.

When the run ends, forge asks GitHub whether an open pull request from a
branch of the repository itself closes the ticket, ignoring pull requests from
forks or other repositories. If one does, the ticket becomes `forge:done`,
however the run ended, except a run that exceeded its timeout or budget, which
always fails. Otherwise it becomes `forge:failed`. The Work page shows each ticket's
dispatch state, and for a failed ticket its reason, linked to its run: the run
errored, it ended without a pull request (with the agent's final message), the
skill was not found, the run was interrupted, or it was stopped for exceeding
its timeout or budget. Each dispatch moves a ticket
labelled `forge:running` that no live dispatch is working on to `forge:failed`
as interrupted, and moves one whose dispatch already ended to the label of its
recorded outcome. To retry a ticket, label it `forge:ready` again. The labels are
the only thing forge writes to a ticket. On a host that dispatches, each
frontier sync also makes sure every declared repository has the four `forge:*`
labels, with their fixed descriptions and colours.

## The workload sandbox

Every workload's harness, and every subagent it spawns, runs in a bubblewrap
sandbox. It sees the Nix store, `/etc`, `/bin` and `/usr` read-only, its own
run directory read-write, and a fresh `/tmp` and HOME that are thrown away
when the workload ends. The state directory, `/run` and every other process
on the box are hidden from it, and it shares the box's network. It cannot
create user namespaces of its own, so tools that need them, such as rootless
containers, do not work in a workload. Anything a workload should keep
belongs in its run directory.

The harness command must be an absolute path. It is resolved to its real path
before the sandbox starts, so a command under `/run/current-system/sw/bin`
works. Any path in the harness's extra `args` must be in the Nix store, since
the sandbox sees nothing else of the box. If the sandbox cannot start, the
workload fails with that reason, and the harness never runs unconfined.

On a host built with `forge.lib.mkHost`, `pkgs.pi-coding-agent` is the pi
forge pins, 1.0.0, patched so that it never writes its agent dir. Install that
one as the `pi` harness, as the template's example does, since the runner
passes it flags and loads skills the way that version expects.

### Nix in a workload

Every workload has `nix` on its path, with `nix-command` and `flakes` enabled
box-wide, so the agent can `nix run` or `nix build` through the box's nix
daemon, using the box's disk and network. Once a week the store is garbage
collected: profile generations older than 14 days, the box's own system
generations included, are deleted, and then every store path nothing roots,
whatever its age. Run directories age out after the same 14 days.

`forge-runtime` is never a trusted nix user, so a workload cannot add unsigned
paths or change substituters, and cannot plant a tool for a later workload
through the store. A host that makes it trusted in `nix.settings.trusted-users`
or `nix.settings.extra-trusted-users`, by name, by one of its groups or through
`*`, does not evaluate, and neither does one that sets either setting in
`nix.extraOptions`. A nix.conf file included from elsewhere is not checked.

### Workload memory

A workload, with its harness, its subagents and every command they run, may
use at most `forge.runtime.workload.memoryMax` of memory, 80% of the box's by
default. Set it to a size such as `"6G"` or another percentage. A workload
that reaches it does not stop: the kernel kills its largest process, in
practice the command that ran away, and the agent sees that command exit with
137 and is told to choose a narrower check. The box has no swap.

The limit is per workload. Workloads running at once, up to
`dispatch.maxConcurrent` dispatches plus any scheduled ones, can together use
more than it, and builds the nix daemon runs for a workload are outside it, so
either can still exhaust the box.

Size the box for the checks your managed repositories run. A check that
evaluates or builds Nix, such as `nix flake check`, can need more memory than
a cx23's 3.7 GB usable, so use a cx33 or larger for a box that manages such a
repository.

### Workload timeout

A workload may run for at most `forge.runtime.workload.timeout`, 2 hours by
default, a systemd time span of whole seconds, minutes, hours, days or weeks
such as `"90min"` or `"1h 30min"`, at most 2147483 seconds, just under 25 days. A worker overrides it with its own
`timeout`, and `null` means unlimited, either as the default or for one worker.
A malformed timeout does not evaluate. There is no per-repository timeout, and
it applies to scheduled and dispatched workloads alike.

The timeout counts from the harness's start, so checkout and devShell setup
do not use it. When it passes, forge kills the workload's sandbox at once,
the harness and every subagent with it, and ends the run as `exceeded`,
recording the timeout it ran under. Whatever the agent had not pushed is lost,
and the agent is neither warned nor told its timeout. The runner exits as for
a failure, and nothing retries the workload.

A dispatched workload that ends exceeded fails its dispatch with the reason
`exceeded`, labels the ticket `forge:failed`, and posts nothing to it. The
dashboard shows an amber `exceeded` pill with a callout such as "Stopped after
2h of a 2h timeout", and the Work page reads "Exceeded timeout". A running
workload's elapsed time ticks against its timeout, such as "45m / 2h", counted
from the harness's start.

### Workload budget

A workload may spend at most `forge.runtime.workload.maxCost`, 5 USD by
default, a positive number of USD. A worker overrides it with its own
`maxCost`, and `null` means unlimited, either as the default or for one worker.
A budget that is not a positive number does not evaluate. There is no
per-repository budget, and it applies to scheduled and dispatched workloads
alike.

The budget covers the whole workload, subagents included. Spend is each
generation's billed cost where OpenRouter has billed it and forge's estimate at
the model's list price otherwise, and the runner checks it after every
generation it records. A workload with a budget whose model's list price forge
cannot fetch from OpenRouter at start is refused before the harness starts and
spends nothing, and its run ends `error`. A generation that has neither a billed
cost nor an estimate, such as one that used cache tokens of a model with no
cache price, ends the workload exceeded, since forge cannot tell what it cost.

When spend passes the budget, forge kills the workload's sandbox at once, the
harness and every subagent with it, and ends the run `exceeded` on its budget,
recording the budget it ran under. Because spend is checked between
generations, a workload can overshoot its budget by the generations in flight
when it is checked, and by more when subagents run concurrently. The agent is
neither warned nor told its budget, and nothing retries the workload. A
dispatched workload that ends exceeded fails its dispatch as described above.

The dashboard shows a running workload's spend against its budget, such as
"$3.20 / $5". An exceeded run has an amber `exceeded` pill with a callout such
as "Stopped at $5.21 of a $5 budget", and the Work page reads "Exceeded
budget".

### Running a worker on a Claude subscription

A worker draws on your Claude subscription instead of OpenRouter when it sets
`provider = "anthropic"` and names Anthropic's own model id:

```nix
forge.runtime.workers.builder = {
  harness = "pi";
  provider = "anthropic";
  model = "claude-opus-5-5";
  prompt = "/work-on {url}";
  maxCost = null;
};
```

Create a long-lived token with `claude setup-token` and store it in
`secrets/runtime.yaml` as `anthropic_oauth_token`. The secret is required only
when some worker uses `anthropic`, and only the runner receives it, as
`ANTHROPIC_OAUTH_TOKEN`. A workload on `anthropic` never gets the OpenRouter
key, an `openrouter` workload never gets the token, and the billing service
never sees it. The token lasts about a year and you rotate it by hand, as
[Rotating a runtime secret](#rotating-a-runtime-secret) describes.

pi reaches Anthropic by presenting itself as Claude Code, which Anthropic could
stop accepting. If it does, only `anthropic` workers stop, and you can move
them back to `openrouter` by changing the provider and the model id.

A subscription workload is never billed. Its cost reads `subscription` on the
dashboard, and billing neither looks up nor settles its generations. Each
generation records its list-price equivalent: its tokens, cache reads and writes
included, at pi's catalog price for the model. A run's page shows the total
labelled as a list-price equivalent, never as billed or estimated cost. A change
of provider starts a new cohort, whose page shows the provider.

The workload budget applies to the list-price equivalent, subagents included. A
budgeted subscription worker whose model pi's catalog cannot price is refused
before it starts and its run ends `error`; set its `maxCost` to `null` to run it
unbudgeted.

Hitting the subscription's 5-hour or weekly limit ends the run `error` with
Anthropic's message, like any provider error. Nothing pauses dispatch or falls
back to OpenRouter.

## Inspecting the run store

Runs, their generations and billed cost live in the SQLite store
`/var/lib/forge/forge.db`. To inspect them:

```bash
just ssh sudo -u forge-runtime sqlite3 -readonly /var/lib/forge/forge.db \
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

## Upgrading forge

Updating the forge input changes the box's NixOS system and your toolchain, but
not the files this repository was scaffolded with. `justfile`, this README and
`tests/divergence-guard.sh` are copies of forge's template, so a new forge
version can need new copies of them, and new secrets.

1. Update the forge input, or lock it to a new commit as
   [Pinning forge](#pinning-forge) describes, and move the ref in
   `infra/opentofu/main.tf` with it if you pinned that too:

   ```bash
   nix flake update forge
   ```

2. Scaffold the template at the commit you now pin into a scratch directory,
   and list the files that differ from yours:

   ```bash
   rev="$(jq -r '.nodes.forge.locked.rev' flake.lock)"
   template="$(mktemp -d)"
   nix flake new -t "github:rameezk/forge/${rev}#operator" "$template"
   diff -rq "$template" . | grep -v '^Only in \.'
   ```

3. Copy over each file that differs and that you have not changed yourself,
   such as `justfile`, `README.md` and `tests/divergence-guard.sh`. Merge
   `flake.nix`, `.sops.yaml` and `infra/opentofu/main.tf` by hand instead,
   since they hold your workers, recipients and module ref. `config.json`,
   `known_hosts` and `secrets/` are never in the template.

4. Fetch the OpenTofu module again. `tofu init` keeps the module it fetched
   first, even when its `source` tracks a branch, and this fetches modules
   only, leaving your provider lock as it is:

   ```bash
   tofu -chdir=infra/opentofu get -update
   ```

5. Add any secret the new README asks for, in the secrets step of
   [First run](#first-run). A missing runtime secret fails the build on the
   box, and a missing operator secret fails standup and teardown.

6. Run the divergence guard, then stage and commit:

   ```bash
   bash tests/divergence-guard.sh
   git add -A
   git commit -m "chore: upgrade forge"
   ```

7. Apply the upgrade with `just deploy`, which keeps the box's state. If the
   upgrade changed how the box is reached, as the move to the tailnet did, or
   changed `infra/opentofu`, run `just teardown` then `just standup` instead,
   which loses the box's state.
