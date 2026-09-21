# 0004. Metrics substrate: SQLite now, OpenTelemetry deferred

## Status

Accepted

## Context

The first agent-workload runtime slice (deferred by ADR-0001) needs to persist per-workload metrics - start time, end time, and total cost spent - for a local, read-only frontend running on the same box. Cost is captured from the pi harness's own usage output, with OpenRouter's generation API as a fallback. The box today runs only SSH: nothing else is long-lived, and its posture is minimal-exposure and secret-free.

Options for where the metrics live and how the frontend reads them:

- Option 1: SQLite file on the box - one `runs` table (start, end, cost, worker, model, status), written through a single `record(result)` seam in the runner and read directly by the frontend. Minimal machinery, no new long-running services, fully queryable.
- Option 2: OpenTelemetry - the runner emits spans (a workload maps cleanly onto a span; cost is a span attribute or a counter) to an OTel Collector, stored in a backend (Prometheus for the metric, Tempo/Jaeger/ClickHouse for traces), which the frontend then queries. Semantically the right model and the industry standard, but it stands up two to three new long-running services and their config, widens exposure, and pushes the frontend toward being a client of a tracing backend (or toward Grafana instead of a bespoke app).
- Option 3: Append-only JSONL log - simplest to write, but weak querying and no schema as fields and run volume grow.

## Decision

We will go with Option 1: a SQLite file on the box, written through a single `record(result)` function in the runner and read directly by the frontend. The one-function seam is deliberate: it localizes a future swap to an OTel exporter to one place rather than a rewrite.

## Consequences

For a handful of local runs and three metrics, this is the least machinery that meets the need: no collector, no backend, no new exposure, and the frontend reads the file directly. The cost is that we are not on the observability standard - there are no distributed traces, no retention policy, no cross-run correlation out of the box. When workloads go multi-box and want real observability rather than a dashboard, OTel becomes the right call, and the semantic fit (a workload is a span) plus the `record()` seam are what that migration will exploit. Migrating then carries real cost - data migration, standing up the collector and backend, and reworking the frontend to query it - which is why this ADR records the choice rather than leaving it implicit.
