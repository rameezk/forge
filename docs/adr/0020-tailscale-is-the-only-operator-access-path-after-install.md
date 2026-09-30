# 0020. Tailscale is the only operator access path after install

## Status

Accepted

## Context

The operator reaches the box over public SSH on `sshPort`, and reaches the localhost-only dashboard by opening an SSH tunnel each time. Public SSH is exposed to the whole internet, and the tunnel has to be re-established for every visit.

- Option 1: Add Tailscale alongside public SSH. Public SSH stays exposed.
- Option 2: Every box joins the operator's tailnet, and once installed, public SSH closes and the tailnet is the only way in. nixos-anywhere still installs over the public IP, since the box is not on the tailnet until NixOS runs.
- Option 3: Also install over the tailnet, with a custom installer image that joins the tailnet itself. Considerable extra machinery for a one-time step.
- Option 4: Make Tailscale optional per operator. Two access models to document, test and keep working.

Reinstalling leaves the old device registered under the name. It can be removed by the standup tooling through the Tailscale API, by registering the box as an ephemeral device (removed only after it has been offline for a while, so a quick reinstall still collides), or by hand.

The box can join the tailnet using either a hand-minted auth key (expires within 90 days, so a later standup fails until someone re-mints it) or an OAuth client secret that registers a tagged device (never expires; tagged devices have no node-key expiry). Over the tailnet, SSH can be OpenSSH (keeps ADR-0012's pinned host key) or Tailscale SSH (tailnet ACLs decide who gets a shell, and no host key is pinned). The dashboard can stay on localhost behind `tailscale serve`, or bind to the tailnet interface.

## Decision

We will go with Option 2, required on every box. The box joins its operator's tailnet as a device tagged `tag:forge`, using an OAuth client secret held in `secrets/runtime.yaml`. SSH stays OpenSSH with the pinned host key and reaches the box over the tailnet only. The dashboard stays bound to localhost and is exposed to the tailnet over HTTPS through `tailscale serve`. The operator sets up the tailnet's policy (`tagOwners` for `tag:forge`, and who can reach it) and the OAuth client by hand. Forge does not manage the tailnet, because that would overwrite the operator's whole tailnet policy.

The box's tailnet name is its config.json `hostname`, and the dashboard's one URL is `https://<hostname>.<tailnet>.ts.net`. Every standup reinstalls from a clean disk, so the box joins as a new device, and a leftover device would take the name and push the new one to `<hostname>-1`. To prevent that, `just standup` and `just teardown` delete the old `tag:forge` device named `<hostname>` through the Tailscale API. They use a second, operator-only OAuth client held in `secrets/operator.yaml`, so the box never holds a credential that can delete devices.

## Consequences

The box accepts no SSH connections from the public internet, and the dashboard is always available on the tailnet with no tunnel. Every operator needs a tailnet with MagicDNS and HTTPS certificates enabled. If Tailscale fails on the box, the only way back in is the Hetzner console. Standup still needs public SSH until the installed system takes over.
