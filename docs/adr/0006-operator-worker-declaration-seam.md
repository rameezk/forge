# 0006. Operator worker-declaration seam: a `modules` passthrough on `mkHost`

## Status

Accepted

Extends ADR-0005.

## Context

ADR-0005 decided that runtime config lives in a typed NixOS module under `forge.runtime.*` and is "set in the operator repository's flake." The flake never provided the seam to do so: `forge.lib.mkHost` takes only `{ configFile }` and composes a fixed module list, and forge exports no reusable NixOS module. So `forge.runtime.harnesses`/`workers` can be set only inside forge's own checks (the `workerHost` fixture, which hand-rolls `lib.nixosSystem`), never through the operator-facing surface. ADR-0005's mandate was written but not wired.

Options:

- Option 1: Add a `modules ? [ ]` parameter to `mkHost`, appended to its composed module list. The operator sets `forge.runtime.*` in an inline module passed there. Keeps mkHost's composed host (disko, configuration, runtime, overlay) intact, and puts runtime config exactly where ADR-0005 says - the operator's flake.
- Option 2: Export `forge.nixosModules.default` (the runtime module) and have the operator build their own `lib.nixosSystem`. Full control, but abandons mkHost's composition: the operator re-assembles disko/configuration/overlay by hand, duplicating what mkHost exists to hide.
- Option 3: Add `harnesses`/`workers` to `config.json`/`loadConfig`. One data file, but contradicts ADR-0005 - it deliberately kept runtime config out of `config.json` and its byte-identical divergence guard - reopening the decision 0005 just closed.

## Decision

We will go with Option 1: `mkHost` accepts an optional `modules` list appended to its composed module set, and operators declare `forge.runtime.harnesses.*`/`workers.*` in an inline module passed to `mkHost` from their flake. This realizes ADR-0005's "set in the operator's flake" rather than revising it, and reuses the exact declaration pattern forge's own `workerHost` check already proves.

## Consequences

`mkHost`'s public signature gains one optional argument; with `modules` omitted the composed base host is byte-for-byte unchanged, so existing operators are unaffected. Operators now have a supported path to declare a worker (an inline module setting `forge.runtime.*`, plus `environment.systemPackages = [ pkgs.pi-coding-agent ]` to install the harness binary), and forge packages no harness itself, staying harness-agnostic per CONTEXT.md. A `mkHost`-through check guards the seam, closing the gap where only the `lib.nixosSystem` bypass was ever exercised. This does not address the runner's current hard-coding of `harness === 'pi'`, which is tracked separately.
