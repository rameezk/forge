# 0008. The pi adapter owns pi's CLI contract, and OpenRouter is the source of cost

## Status

Accepted

## Context

The runner's pi invocation (`run --model --reasoning-effort --prompt`) was written against a fake and never matched any real pi. It failed on the first live run with pi 0.75.4, the version forge's locked nixpkgs ships to every operator host. Real pi takes a positional prompt, `--mode json`, `--thinking`, and `--provider` (it defaults to google). Its JSON stream is its own schema with provider errors reported in-stream under exit 0. It prices usage from a bundled catalog, ignores OpenRouter's reported cost, and silently prices models it does not know at its default model's rates.

- Option 1: Operators own pi's flags through harness `args`, and the runner only appends per-worker values. Flexible, but the output format the runner parses becomes operator-editable, and drift stays invisible until a live run.
- Option 2: The pi adapter owns the full invocation and translates pi's events into forge's harness-neutral `HarnessEvent`, trusting pi's catalog cost. Contained, but cost is wrong or zero for any model outside pi's catalog.
- Option 3: As Option 2, but the provider is fixed to `openrouter`, and cost is read from OpenRouter's generation stats per assistant response, marking the run cost-uncertain when that lookup fails.

## Decision

We will go with Option 3. The adapter builds `--mode json --no-session --offline --provider openrouter --model <id> [--thinking <e>] <prompt>`, keeps harness `args` only as operator extras, and maps pi's stream into `HarnessEvent`. The contract is guarded by a recorded fixture of real pi output and by a flake check that runs the locked `pi-coding-agent` against the exact argv the adapter emits.

## Consequences

A nixpkgs bump that changes pi's CLI fails a check instead of a live run. Recorded cost is what OpenRouter billed, independent of pi's catalog or version, at the price of one OpenRouter API call per assistant response. Forge supports only OpenRouter models through pi until another provider key is wired. The runner still hard-codes `harness === 'pi'` (ADR-0006); a second harness would add its own adapter behind the same `HarnessEvent` seam.
