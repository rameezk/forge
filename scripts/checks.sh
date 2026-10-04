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
mapfile -t drv_paths < <(jq -r '.[]' <<<"$drvs")

if [ ${#drv_paths[@]} -eq 0 ]; then
	exit 0
fi

selected="$(nix derivation show "${drv_paths[@]}" | jq -c --argjson checks "$drvs" --arg selection "$selection" '
	(.derivations // .) as $derivations
	| $checks
	| to_entries[]
	| ($derivations[.value | ltrimstr("/nix/store/")] // $derivations[.value] // error("nix derivation show did not describe the check \(.key)")) as $derivation
	| ($derivation.structuredAttrs.requiredSystemFeatures
		// ($derivation.env.__json // "{}" | fromjson | .requiredSystemFeatures)
		// ($derivation.env.requiredSystemFeatures // "" | split(" "))) as $features
	| select(($features | any(. == "kvm" or . == "nixos-test")) == ($selection == "vm"))
')"

if [ "$command" = list ]; then
	jq -r '.key' <<<"$selected"
else
	mapfile -t installables < <(jq -r '.value + "^*"' <<<"$selected")
	if [ ${#installables[@]} -gt 0 ]; then
		nix build --no-link "${installables[@]}"
	fi
fi
