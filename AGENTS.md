# AGENTS.md

## Code

- Never write code comments. No `//`, `#`, `--`, `/* */`, section headers, or
  explanatory inline notes. If something genuinely needs explanation, put it in
  the commit message or pull request description. Variable or output
  `description` attributes and docstrings on public APIs are not comments and
  are fine.
- Never manually modify `CHANGELOG.md` files or any file marked as
  auto-generated.
- When making technical decisions, do not give much weight to development cost.
  Prefer quality, simplicity, robustness, scalability, and long term
  maintainability.
- For one-off or infrequent operational work, take the simplest direct
  end-to-end path. Do not build wrappers, control planes, policy layers, custom
  verifiers, or automation unless the direct path exposes a concrete blocker or
  a repeated need that justifies the added machinery.

## Bugs, tests and quality

- When fixing a bug, start by reproducing it end to end, as close as possible to
  how a user would experience it, so the fix addresses the real problem.
- When testing the frontend end to end, be picky about the UI and aim for pixel
  perfection. If something clearly looks off, fix it along the way even if it is
  not directly related to the task.
- Hold the same standard for lint errors, test failures, and flaky tests: fix
  them when you see them, even if your change did not cause them.
- CI is the full gate: it runs `make check-no-vm` and every NixOS VM test.
  Never run the full `make check-no-vm` locally. Run only the scoped commands
  for the areas you changed:
  - a TypeScript package under `runtime/packages`: run `npm ci` in `runtime/`
    first if `runtime/node_modules` is missing, then `npm run typecheck` in
    `runtime/` and `npm test` in that package's directory, which runs
    `node --test` over its unit tests
  - OpenTofu: `tofu test`
  - repo and template scripts: the matching `tests/*.sh` script
  - a single nix check: `nix build .#checks.<system>.<check>`; a VM test lives
    in `vmTests`, so `nix flake check` alone no longer covers it
- End your report with one line naming the local commands that passed,
  followed by "full suite: CI".
- When a required scoped command is killed or cannot run, stop and report it.
  Do not substitute a narrower or different check.
- When a VM test fails in CI, start from its log. Run only that test locally,
  with `nix build .#vmTests.<system>.<test>`, if the log does not explain the
  failure.
- A change is not done until the required checks on its pull request are
  green.

## Writing

- Never use the em dash. Use a plain dash `-` instead.
- Never add agent attribution of any kind to a commit message, pull request
  title or body, GitHub issue, or GitHub comment. That covers `Co-Authored-By`
  trailers, "Generated with" credits, and session links or references.
