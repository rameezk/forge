# 0083. The dashboard is read-only to forge.db in the app, not the mount

## Status

Accepted

## Context

ADR-0024 left tightening each non-workload unit's state directory access as a follow-up. Every unit other than the dashboard already holds the OpenRouter key or the GitHub App key, which is worth more than write access to the state directory, so only `forge-frontend` is narrowed: it is the one network-facing unit, holds no secrets and only reads. `forge.db` runs in WAL mode, and a SQLite reader must create or write `forge.db-shm` and `forge.db-wal`. SQLite deletes both when the last connection closes, and every writer is a oneshot, so they are usually absent when the dashboard opens.

- Option 1: Mount `forge.db` read-only for the dashboard. Its open fails whenever the WAL files are absent.
- Option 2: Mount the state directory read-only but bind `forge.db-wal` and `forge.db-shm` read-write. The binds go stale once SQLite unlinks and recreates the files, and a writable `-wal` can still change the database.
- Option 3: Drop WAL for the rollback journal so a read-only mount works. Readers and writers then block each other everywhere, and a hot journal left by a crashed writer stops read-only readers until a writer runs.
- Option 4: Keep WAL and the mount read-write for `forge.db`. The dashboard opens it with `readOnly: true` and never migrates, a `forge-migrate` oneshot migrates before it starts, `transcripts/` is mounted read-only and `work/` and `agent/` are inaccessible.

## Decision

We will go with Option 4. Every other unit keeps `ReadWritePaths=/var/lib/forge`.

## Consequences

A bug in the dashboard can no longer write `forge.db`, change the schema, or touch transcripts and run directories. A compromised dashboard can still write `forge.db` through the mount. Adding `forge.db` to the dashboard's `ReadOnlyPaths` breaks it. Narrowing another unit later needs its own reason.
