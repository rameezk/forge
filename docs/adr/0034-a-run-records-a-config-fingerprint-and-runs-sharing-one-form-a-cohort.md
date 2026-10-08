# 0034. A run records a config fingerprint, and runs sharing one form a cohort

## Status

Accepted, amended by ADR-0048

## Context

To tell whether forge improves as its config changes, runs have to be compared by the config that produced them. A run stores only its worker name, harness and model, so runs under a changed prompt, reasoning effort, skill or pi version are indistinguishable. Every ticket differs, so comparison is between groups of runs, not between paired runs. Forge's own git sha changes on every commit, most of which do not change agent behaviour.

- Option 1: Store only a hash of the config. Groups runs, but cannot show what differs between two groups.
- Option 2: Store one column per config field. Easy to query, but every new field needs a migration and old rows stay blank for it.
- Option 3: Store a JSON snapshot of the behaviour-relevant config and a hash over it, with forge's git sha and the managed repository's base commit as separate columns outside the hash.
- Option 4: As Option 3, but with forge's git sha inside the hash.

## Decision

We will go with Option 3. At run start forge records a config fingerprint: a snapshot of the model, reasoning effort, harness extra args, and hashes of the prompt template, the system prompt, the tool definitions and the skill files, plus the harness version, with a hash over it. The system prompt and tool definitions are hashed from the request record. Forge's git sha and the base commit are stored beside it, not in it. Runs sharing a fingerprint hash form a cohort. A run recorded before fingerprints existed belongs to an unknown-config cohort and is never given a fingerprint rebuilt from the current worker config.

## Consequences

Cohorts can be compared, and any two diffed field by field. A forge change that alters behaviour shows up through the prompt, system prompt, tool or skill hashes, so commits that change nothing do not split cohorts; a behaviour change outside those inputs goes unnoticed until a field is added. Adding a field changes every later hash, so it starts new cohorts by design. The base commit is what a later replay of past tickets would pin to. Cohorts still mix tickets of different difficulty, so their comparison is indicative rather than controlled.
