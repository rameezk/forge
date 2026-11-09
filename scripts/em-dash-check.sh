#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 0 ]; then
	echo "usage: $0" >&2
	exit 2
fi

cd "$(git rev-parse --show-toplevel)"

dash="$(printf '\xe2\x80\x94')"

set +e
found="$(git -c core.quotePath=false grep -nIF --full-name -e "$dash" -- . \
	':(exclude,glob)**/test/fixtures/**' \
	':(exclude,glob)**/flake.lock' \
	':(exclude,glob)**/package-lock.json')"
status=$?
set -e

case "$status" in
0)
	echo "em dash found; use a plain dash '-' instead:" >&2
	sed 's/^/  /' <<<"$found" >&2
	exit 1
	;;
1) echo "no em dash in any tracked file" ;;
*) exit "$status" ;;
esac
