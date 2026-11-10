#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
script="$forge/scripts/em-dash-check.sh"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT

dash="$(printf '\xe2\x80\x94')"
fail=0

git -C "$scratch" init --quiet
git -C "$scratch" config user.email test@example.com
git -C "$scratch" config user.name test
echo clean >"$scratch/README.md"
git -C "$scratch" add .
git -C "$scratch" commit --quiet -m base

reset_scratch() {
	git -C "$scratch" reset --quiet --hard
	git -C "$scratch" clean --quiet -fdx
}

write() {
	mkdir -p "$(dirname "$scratch/$1")"
	printf 'before %s after\n' "$dash" >"$scratch/$1"
}

run_check() {
	(cd "$scratch" && "$script" 2>&1)
}

assert_passes() {
	local description="$1" output
	if output="$(run_check)"; then
		echo "ok: $description"
	else
		echo "FAIL: $description: the check failed: $output"
		fail=1
	fi
}

assert_fails_naming() {
	local description="$1" expected="$2" output
	if output="$(run_check)"; then
		echo "FAIL: $description: the check passed"
		fail=1
	elif [[ "$output" == *"$expected"* ]]; then
		echo "ok: $description"
	else
		echo "FAIL: $description: output did not contain '$expected': $output"
		fail=1
	fi
}

assert_passes "a clean tree passes"

reset_scratch
printf 'one\ntwo %s\n' "$dash" >"$scratch/notes.txt"
git -C "$scratch" add notes.txt
assert_fails_naming "an em dash in a tracked file fails naming the file and line" "notes.txt:2"

reset_scratch
write src/deep/code.ts
git -C "$scratch" add -A
assert_fails_naming "an em dash in a nested tracked file fails" "src/deep/code.ts:1"

reset_scratch
write a.md
write b.md
git -C "$scratch" add -A
output="$(run_check || true)"
if [[ "$output" == *"a.md:1"* && "$output" == *"b.md:1"* ]]; then
	echo "ok: every offending file is named"
else
	echo "FAIL: every offending file is named: $output"
	fail=1
fi

reset_scratch
write runtime/packages/runner/test/fixtures/claude-code/stream.jsonl
write test/fixtures/out.txt
write flake.lock
write package-lock.json
write runtime/package-lock.json
git -C "$scratch" add -A
assert_passes "em dashes only in exempt files pass"

reset_scratch
write fixtures/out.txt
write mytest/fixtures/out.txt
git -C "$scratch" add -A
assert_fails_naming "a fixtures directory outside test/fixtures is not exempt" "fixtures/out.txt:1"

reset_scratch
write notflake.lock
git -C "$scratch" add -A
assert_fails_naming "a file merely ending in an exempt name is not exempt" "notflake.lock:1"

reset_scratch
write untracked.md
assert_passes "an em dash only in an untracked file passes"

reset_scratch
write .agents/skills/demo/SKILL.md
git -C "$scratch" add -A
assert_fails_naming "an em dash in a vendored skill fails" ".agents/skills/demo/SKILL.md"

reset_scratch
write "with space.md"
git -C "$scratch" add -A
assert_fails_naming "a path with a space is named" "with space.md:1"

reset_scratch
write staged.md
git -C "$scratch" add -A
git -C "$scratch" commit --quiet -m dash
assert_fails_naming "a committed em dash fails" "staged.md:1"

exit "$fail"
