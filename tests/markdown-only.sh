#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
script="$forge/scripts/markdown-only.sh"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT

fail=0

git -C "$scratch" init --quiet
git -C "$scratch" config user.email test@example.com
git -C "$scratch" config user.name test
mkdir -p "$scratch/docs/assets" "$scratch/docs/adr" "$scratch/src"
echo base >"$scratch/README.md"
echo base >"$scratch/docs/assets/logo.svg"
echo base >"$scratch/src/main.rs"
git -C "$scratch" add .
git -C "$scratch" commit --quiet -m base
base="$(git -C "$scratch" rev-parse HEAD)"

commit_change() {
	git -C "$scratch" add -A
	git -C "$scratch" commit --quiet -m change
	git -C "$scratch" rev-parse HEAD
	git -C "$scratch" reset --quiet --hard "$base"
}

assert_decision() {
	local description="$1" base_ref="$2" head_ref="$3" expected="$4" actual
	if ! actual="$(cd "$scratch" && "$script" "$base_ref" "$head_ref")"; then
		echo "FAIL: $description: the script failed"
		fail=1
	elif [ "$actual" = "$expected" ]; then
		echo "ok: $description"
	else
		echo "FAIL: $description: expected '$expected', got '$actual'"
		fail=1
	fi
}

echo changed >"$scratch/README.md"
echo adr >"$scratch/docs/adr/0001-x.md"
echo skill >"$scratch/src/NOTES.md"
markdown_only="$(commit_change)"

echo changed >"$scratch/README.md"
echo changed >"$scratch/src/main.rs"
mixed="$(commit_change)"

echo changed >"$scratch/docs/assets/logo.svg"
logo="$(commit_change)"

git -C "$scratch" mv README.md README.txt
renamed="$(commit_change)"

git -C "$scratch" rm --quiet README.md
deleted_markdown="$(commit_change)"

assert_decision "a change to only markdown files in any directory is markdown-only" "$base" "$markdown_only" true
assert_decision "a deleted markdown file is markdown-only" "$base" "$deleted_markdown" true
assert_decision "a markdown file and another file is a code change" "$base" "$mixed" false
assert_decision "a non-markdown file under docs is a code change" "$base" "$logo" false
assert_decision "a markdown file renamed to another type is a code change" "$base" "$renamed" false
assert_decision "an unchanged head is a code change" "$base" "$base" false
assert_decision "an all-zero base is a code change" 0000000000000000000000000000000000000000 "$markdown_only" false
assert_decision "an empty base is a code change" "" "$markdown_only" false
assert_decision "a base missing from history is a code change" 1111111111111111111111111111111111111111 "$markdown_only" false

exit "$fail"
