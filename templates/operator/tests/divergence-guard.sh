#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

nix_flags="${FORGE_NIX_FLAGS:-}"
fake_token="0000000000000000000000000000000000000000000000000000000000000000"

echo "==> nix flake check: build the host, assert its keys reflect config.json"
nix flake check $nix_flags

echo "==> tofu test: plan the OpenTofu root, assert its keys reflect config.json"
(
	cd infra/opentofu
	tofu init -input=false >/dev/null
	tofu test
)

echo "==> cross-tool: assert built keys, planned keys, and config.json are byte-identical"
config_keys="$(jq -cS '.sshPublicKeys' config.json)"
nix_keys="$(nix eval --json $nix_flags .#lib.reflect.authorizedKeys | jq -cS '.')"

plan_file="$(mktemp)"
trap 'rm -f "$plan_file"' EXIT
(
	cd infra/opentofu
	tofu plan -input=false -var="hcloud_token=$fake_token" -out="$plan_file" >/dev/null
)
tofu_keys="$(tofu -chdir=infra/opentofu show -json "$plan_file" | jq -cS '.planned_values.outputs.ssh_public_keys.value')"

if [ "$config_keys" = "$nix_keys" ] && [ "$nix_keys" = "$tofu_keys" ]; then
	echo "ok: built keys == planned keys == config.json"
else
	echo "FAIL: the two tools disagree about the SSH keys"
	echo "  config.json: $config_keys"
	echo "  built host:  $nix_keys"
	echo "  tofu plan:   $tofu_keys"
	exit 1
fi

echo "divergence guard passed"
