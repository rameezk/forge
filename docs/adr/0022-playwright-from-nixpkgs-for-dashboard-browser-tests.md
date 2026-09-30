# 0022. Playwright with nixpkgs browsers for dashboard browser tests

## Status

Accepted

## Context

Live updates (ADR-0021) put behaviour in the browser - morphing, kept `<details>` state, transcript following, a live indicator - that `node --test` against rendered HTML cannot exercise. The repo has no browser test tooling, and its tests run inside Nix builds.

- Option 1: Playwright, pinned to the nixpkgs `playwright-driver` version, with browsers from nixpkgs via `PLAYWRIGHT_BROWSERS_PATH`, run as a Linux-only flake check and from the dev shell.
- Option 2: The same, but as a flake check on every platform, putting Chromium inside the macOS Nix sandbox where it tends to be flaky.
- Option 3: Playwright run only by hand from the dev shell.
- Option 4: No browser tests: server tests plus manual checks and screenshots.

## Decision

We will go with Option 1, testing in Chromium only.

## Consequences

Client behaviour is guarded in CI without any browser downloaded at test time. `@playwright/test` must move in lockstep with nixpkgs' `playwright-driver`, so a nixpkgs bump can force a Playwright bump. macOS only runs the suite from the dev shell, and Firefox and WebKit regressions go uncaught.
