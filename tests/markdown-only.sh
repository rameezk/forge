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

commit_index() {
	git -C "$scratch" commit --quiet -m change
	git -C "$scratch" rev-parse HEAD
	git -C "$scratch" reset --quiet --hard "$base"
}

commit_change() {
	git -C "$scratch" add -A
	commit_index
}

from() {
	git -C "$scratch" reset --quiet --hard "$1"
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

mkdir -p "$scratch/.agents/skills/demo/references" "$scratch/.claude/skills"
echo skill >"$scratch/.agents/skills/demo/SKILL.md"
echo notes >"$scratch/.agents/skills/demo/references/notes.md"
ln -s ../../.agents/skills/demo "$scratch/.claude/skills/demo"
skill_added="$(commit_change)"

assert_decision "a markdown skill directory and its symlink added together are markdown-only" "$base" "$skill_added" true

from "$skill_added"
git -C "$scratch" rm --quiet -r .agents/skills/demo .claude/skills/demo
skill_removed="$(commit_change)"

assert_decision "a markdown skill directory and its symlink removed together are markdown-only" "$skill_added" "$skill_removed" true

mkdir -p "$scratch/.agents/skills/demo/references" "$scratch/.agents/skills/tool/scripts/lib"
echo skill >"$scratch/.agents/skills/demo/SKILL.md"
echo notes >"$scratch/.agents/skills/demo/references/notes.md"
echo skill >"$scratch/.agents/skills/tool/SKILL.md"
echo run >"$scratch/.agents/skills/tool/scripts/lib/run.sh"
skills_without_symlinks="$(commit_change)"

from "$skills_without_symlinks"
mkdir -p "$scratch/.claude/skills"
ln -s ../../.agents/skills/demo "$scratch/.claude/skills/demo"
symlink_to_markdown_directory="$(commit_change)"

from "$skills_without_symlinks"
mkdir -p "$scratch/.claude/skills"
ln -s ../../.agents/skills/tool "$scratch/.claude/skills/tool"
symlink_to_directory_with_script="$(commit_change)"

assert_decision "a symlink added to an existing directory of markdown is markdown-only" "$skills_without_symlinks" "$symlink_to_markdown_directory" true
assert_decision "a symlink added to a directory holding a nested script is a code change" "$skills_without_symlinks" "$symlink_to_directory_with_script" false

ln -s ../README.md "$scratch/docs/readme"
symlink_to_markdown_file="$(commit_change)"

ln -s ../src/main.rs "$scratch/docs/main"
symlink_to_source_file="$(commit_change)"

assert_decision "a symlink added to a markdown file is markdown-only" "$base" "$symlink_to_markdown_file" true
assert_decision "a symlink added to a file that is not markdown is a code change" "$base" "$symlink_to_source_file" false

ln -s ../nowhere.md "$scratch/docs/dangling"
dangling_symlink="$(commit_change)"

assert_decision "a symlink whose target does not exist is a code change" "$base" "$dangling_symlink" false

ln -s /README.md "$scratch/absolute"
absolute_symlink="$(commit_change)"

ln -s ../../README.md "$scratch/docs/escaping"
escaping_symlink="$(commit_change)"

assert_decision "a symlink to an absolute path is a code change" "$base" "$absolute_symlink" false
assert_decision "a symlink that escapes the repository is a code change" "$base" "$escaping_symlink" false

from "$symlink_to_directory_with_script"
git -C "$scratch" rm --quiet .claude/skills/tool
removed_symlink_to_directory_with_script="$(commit_change)"

assert_decision "a symlink removed from a directory holding a script is a code change" "$symlink_to_directory_with_script" "$removed_symlink_to_directory_with_script" false

from "$symlink_to_markdown_directory"
mkdir -p "$scratch/.agents/skills/other"
echo skill >"$scratch/.agents/skills/other/SKILL.md"
ln -sfn ../../.agents/skills/other "$scratch/.claude/skills/demo"
retargeted_to_markdown_directory="$(commit_change)"

from "$symlink_to_markdown_directory"
ln -sfn ../../.agents/skills/tool "$scratch/.claude/skills/demo"
retargeted_to_directory_with_script="$(commit_change)"

from "$symlink_to_markdown_directory"
ln -s demo "$scratch/.claude/skills/alias"
symlink_to_symlink="$(commit_change)"

from "$skills_without_symlinks"
echo notes >"$scratch/docs/notes.md"
markdown_file_base="$(commit_change)"

from "$markdown_file_base"
rm "$scratch/docs/notes.md"
ln -s ../.agents/skills/demo "$scratch/docs/notes.md"
file_became_symlink_to_markdown_directory="$(commit_change)"

from "$markdown_file_base"
rm "$scratch/docs/notes.md"
ln -s ../src/main.rs "$scratch/docs/notes.md"
file_became_symlink_to_source_file="$(commit_change)"

from "$skills_without_symlinks"
mkdir -p "$scratch/.claude/skills"
ln -s ../../.agents/skills/demo "$scratch/.claude/skills/demo"
echo changed >"$scratch/src/main.rs"
symlink_with_code_change="$(commit_change)"

assert_decision "a symlink retargeted to another directory of markdown is markdown-only" "$symlink_to_markdown_directory" "$retargeted_to_markdown_directory" true
assert_decision "a symlink retargeted to a directory holding a script is a code change" "$symlink_to_markdown_directory" "$retargeted_to_directory_with_script" false
assert_decision "a symlink to another symlink is a code change" "$symlink_to_markdown_directory" "$symlink_to_symlink" false
assert_decision "a markdown file replaced by a symlink to a directory of markdown is markdown-only" "$markdown_file_base" "$file_became_symlink_to_markdown_directory" true
assert_decision "a markdown file replaced by a symlink to a source file is a code change" "$markdown_file_base" "$file_became_symlink_to_source_file" false
assert_decision "a symlink to a directory of markdown alongside a code change is a code change" "$skills_without_symlinks" "$symlink_with_code_change" false

mkdir -p "$scratch/mdocs" "$scratch/src/deep" "$scratch/src/mdocs"
echo notes >"$scratch/mdocs/notes.md"
echo code >"$scratch/src/deep/code.rs"
echo run >"$scratch/src/mdocs/run.sh"
ln -s src/deep "$scratch/hop"
symlinked_directory_base="$(commit_change)"

from "$symlinked_directory_base"
ln -s hop/../mdocs "$scratch/link"
symlink_through_symlinked_directory="$(commit_change)"

assert_decision "a symlink that goes up out of a symlinked directory is a code change" "$symlinked_directory_base" "$symlink_through_symlinked_directory" false

from "$symlinked_directory_base"
ln -s "$(printf 'mdocs\n../src')" "$scratch/multiline"
symlink_with_newline_in_target="$(commit_change)"

assert_decision "a symlink whose target holds a newline is a code change" "$symlinked_directory_base" "$symlink_with_newline_in_target" false

ln -s .. "$scratch/docs/root"
symlink_to_repository_root="$(commit_change)"

assert_decision "a symlink to the repository root is a code change" "$base" "$symlink_to_repository_root" false

from "$symlinked_directory_base"
mkdir -p "$scratch/docs/guides"
echo guide >"$scratch/docs/guides/intro.md"
symlink_blob="$(printf 'docs/guides\n' | git -C "$scratch" hash-object -w --stdin)"
git -C "$scratch" add -A
git -C "$scratch" update-index --add --cacheinfo "120000,$symlink_blob,link"
symlink_with_trailing_newline_in_target="$(commit_index)"

assert_decision "a symlink whose target ends in a newline is a code change" "$symlinked_directory_base" "$symlink_with_trailing_newline_in_target" false

from "$symlinked_directory_base"
ln -s :/mdocs "$scratch/magic"
symlink_through_pathspec_magic="$(commit_change)"

assert_decision "a symlink whose target looks like a pathspec is judged by its literal path" "$symlinked_directory_base" "$symlink_through_pathspec_magic" false

from "$base"
git -C "$scratch" update-index --add --cacheinfo "160000,1111111111111111111111111111111111111111,vendor"
submodule_base="$(commit_index)"

from "$submodule_base"
echo changed >"$scratch/README.md"
git -C "$scratch" add -A
git -C "$scratch" update-index --cacheinfo "160000,2222222222222222222222222222222222222222,vendor"
submodule_moved="$(commit_index)"

git -C "$scratch" config diff.ignoreSubmodules all
assert_decision "a submodule moved alongside a markdown change is a code change even when the diff configuration ignores submodules" "$submodule_base" "$submodule_moved" false
git -C "$scratch" config --unset diff.ignoreSubmodules

from "$base"
quoted_decoy="$scratch/\"x"
tab_directory="$scratch/x/a$(printf '\t')b"
mkdir -p "$quoted_decoy/a\\tb" "$quoted_decoy/sub" "$scratch/x/sub" "$tab_directory"
echo notes >"$quoted_decoy/sub/notes.md"
echo notes >"$quoted_decoy/a\\tb/notes.md"
echo code >"$scratch/x/sub/run.sh"
echo notes >"$tab_directory/notes.md"
quoted_names_base="$(commit_change)"

from "$quoted_names_base"
ln -s ../sub "$tab_directory/link"
symlink_in_directory_git_quotes="$(commit_change)"

assert_decision "a symlink in a directory whose name git quotes is a code change" "$quoted_names_base" "$symlink_in_directory_git_quotes" false

from "$symlinked_directory_base"
mkdir -p "$scratch/linked"
ln -s ../src/deep/code.rs "$scratch/linked/notes.md"
directory_holding_symlink_base="$(commit_change)"

from "$directory_holding_symlink_base"
ln -s linked "$scratch/link"
symlink_to_directory_holding_symlink="$(commit_change)"

assert_decision "a symlink to a directory holding a markdown-named symlink is a code change" "$directory_holding_symlink_base" "$symlink_to_directory_holding_symlink" false

exit "$fail"
