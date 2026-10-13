#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 2 ]; then
	echo "usage: $0 BASE HEAD" >&2
	exit 2
fi
base="$1"
head="$2"

export GIT_LITERAL_PATHSPECS=1

verdict=false
trap 'echo "$verdict"; exit 0' EXIT

if [ -z "$base" ] || [[ "$base" =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
	exit 0
fi

lookup() {
	local out
	out="$(git -c core.quotePath=false ls-tree --full-tree "$1" -- "$2")"
	entry_mode="${out%% *}"
	entry_sha="${out#* * }"
	entry_sha="${entry_sha%%$'\t'*}"
}

require_markdown_directory() {
	local listing line mode name
	listing="$(git -c core.quotePath=false ls-tree -r "$1")"
	while IFS= read -r line; do
		mode="${line%% *}"
		name="${line#*$'\t'}"
		case "$mode" in
		100644 | 100755) ;;
		*) exit 0 ;;
		esac
		[[ "$name" == *.md ]] || exit 0
	done <<<"$listing"
}

join_stack() {
	joined=""
	if [ "${#stack[@]}" -gt 0 ]; then
		joined="$(IFS=/ && echo "${stack[*]}")"
	fi
}

check_symlink() {
	local tree="$1" blob="$2" path="$3" target part joined
	local -a stack=() parts=()
	target="$(git cat-file blob "$blob")"
	[ "$(printf %s "$target" | wc -c)" -eq "$(git cat-file -s "$blob")" ] || exit 0
	[[ "$target" != /* && "$target" != *$'\n'* ]] || exit 0
	if [[ "$path" == */* ]]; then
		IFS=/ read -ra stack <<<"${path%/*}"
	fi
	IFS=/ read -ra parts <<<"$target"
	for part in "${parts[@]}"; do
		case "$part" in
		"" | .) ;;
		..)
			[ "${#stack[@]}" -gt 0 ] || exit 0
			join_stack
			lookup "$tree" "$joined"
			[ "$entry_mode" = 040000 ] || exit 0
			unset "stack[${#stack[@]}-1]"
			;;
		*) stack+=("$part") ;;
		esac
	done
	join_stack
	[ -n "$joined" ] || exit 0
	lookup "$tree" "$joined"
	case "$entry_mode" in
	040000) require_markdown_directory "$entry_sha" ;;
	100644 | 100755) [[ "$joined" == *.md ]] || exit 0 ;;
	*) exit 0 ;;
	esac
}

check_side() {
	local tree="$1" mode="$2" blob="$3" path="$4"
	case "$mode" in
	000000) ;;
	100644 | 100755) [[ "$path" == *.md ]] || exit 0 ;;
	120000) check_symlink "$tree" "$blob" "$path" ;;
	*) exit 0 ;;
	esac
}

changed="$(git -c core.quotePath=false diff --raw --no-abbrev --no-renames --ignore-submodules=none "$base" "$head")"
[ -n "$changed" ] || exit 0

while IFS= read -r line; do
	meta="${line%%$'\t'*}"
	path="${line#*$'\t'}"
	[[ "$path" != \"* ]] || exit 0
	read -r old_mode new_mode old_sha new_sha _ <<<"${meta#:}"
	check_side "$base" "$old_mode" "$old_sha" "$path"
	check_side "$head" "$new_mode" "$new_sha" "$path"
done <<<"$changed"

verdict=true
