#!/usr/bin/env bash
set -euo pipefail

flake="${FORGE_FLAKE:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ $# -ne 3 ] || { [ "$1" != list ] && [ "$1" != build ]; } || { [ "$2" != vm ] && [ "$2" != no-vm ]; }; then
	echo "usage: $0 list|build vm|no-vm SYSTEM" >&2
	exit 2
fi
command="$1"
selection="$2"
system="$3"

drvs="$(nix eval --json "$flake#checks.$system" --apply 'builtins.mapAttrs (_: check: check.drvPath)')"

selected="$(jq -r '.[]' <<<"$drvs" | xargs nix derivation show | jq -c --argjson checks "$drvs" --arg selection "$selection" '
	(.derivations // .) as $derivations
	| $checks
	| to_entries[]
	| ($derivations[.value | ltrimstr("/nix/store/")] // $derivations[.value]) as $derivation
	| select($derivation.env.requiredSystemFeatures // "" | split(" ") | any(. == "kvm" or . == "nixos-test") == ($selection == "vm"))
')"

if [ "$command" = list ]; then
	jq -r '.key' <<<"$selected"
else
	mapfile -t installables < <(jq -r '.value + "^*"' <<<"$selected")
	if [ ${#installables[@]} -gt 0 ]; then
		nix build --no-link "${installables[@]}"
	fi
fi
