# 0041. Forge no longer deletes hand-placed GitHub tokens

## Status

Accepted

Amends ADR-0029.

## Context

ADR-0029 has tmpfiles delete a leftover `/var/lib/forge/github.env` and `/var/lib/forge-credentials` "on every activation". NixOS re-runs tmpfiles on a switch only when the tmpfiles configuration changes, so the rules ran at every boot and on the one deploy that added them, never on an ordinary activation. The VM test asserting removal on every activation has failed since it was written. The real box no longer has either path, and no option or unit can create or read them any more.

- Option 1: Keep the tmpfiles rules and test what they actually do: removal at boot.
- Option 2: Remove the files on every activation with an activation script, as ADR-0029 claims.
- Option 3: Drop the cleanup, its assertion and its test, since its one-time migration is done.

## Decision

We will go with Option 3. A box still holding a hand-placed token from before ADR-0029 must have it deleted by hand.

## Consequences

The runtime module carries no migration code for a state no supported configuration can produce. A box stood up before ADR-0029 and not booted or deployed since would keep its plain-text token until the operator removes it.
