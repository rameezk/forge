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
- The NixOS VM tests are part of "tests pass", and CI runs them. Locally,
  run `make check-no-vm` and leave the VM tests to CI.
- When a VM test fails in CI, start from its log. Run only that test locally,
  with `nix build .#checks.<system>.<test>`, if the log does not explain the
  failure.
- A change is not done until the required checks on its pull request are
  green.

## Writing

- Never use the em dash. Use a plain dash `-` instead.
- Never add agent attribution of any kind to a commit message, pull request
  title or body, GitHub issue, or GitHub comment. That covers `Co-Authored-By`
  trailers, "Generated with" credits, and session links or references.
