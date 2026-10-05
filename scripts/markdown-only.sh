#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 2 ]; then
	echo "usage: $0 BASE HEAD" >&2
	exit 2
fi
base="$1"
head="$2"

if [ -z "$base" ] || [[ "$base" =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
	echo false
	exit 0
fi

if ! changed="$(git diff --name-only --no-renames "$base" "$head")"; then
	echo false
	exit 0
fi

if [ -n "$changed" ] && ! grep -qv '\.md$' <<<"$changed"; then
	echo true
else
	echo false
fi
