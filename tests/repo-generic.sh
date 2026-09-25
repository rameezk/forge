#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0

assert_ignored() {
	if git check-ignore -q "$1"; then
		echo "ok: $1 is gitignored"
	else
		echo "FAIL: $1 is not gitignored"
		fail=1
	fi
}

assert_not_ignored() {
	if git check-ignore -q "$1"; then
		echo "FAIL: $1 must stay tracked but is gitignored"
		fail=1
	else
		echo "ok: $1 is not gitignored"
	fi
}

assert_ignored infra/config.json
assert_ignored .env
assert_ignored infra/opentofu/terraform.tfstate
assert_ignored infra/opentofu/terraform.tfstate.backup
assert_ignored infra/opentofu/.terraform/providers
assert_ignored result

assert_not_ignored infra/config.example.json
assert_not_ignored infra/opentofu/.terraform.lock.hcl

if [ -f infra/config.example.json ]; then
	echo "ok: example config is present"
else
	echo "FAIL: example config is missing"
	fail=1
fi

if grep -q "ExamplePlaceholder" infra/config.example.json; then
	echo "ok: example config uses a placeholder SSH key"
else
	echo "FAIL: example config does not use a placeholder SSH key"
	fail=1
fi

if nix eval --json .#lib --apply "l: builtins.attrNames l" 2>/dev/null | grep -q '"mkHost"'; then
	echo "ok: forge exposes the lib.mkHost host builder"
else
	echo "FAIL: forge does not expose the lib.mkHost host builder"
	fail=1
fi

if nix eval --json .#lib --apply "l: builtins.attrNames l" 2>/dev/null | grep -q '"operatorToolchain"'; then
	echo "ok: forge exposes the operator standup toolchain as a library output"
else
	echo "FAIL: forge does not expose lib.operatorToolchain"
	fail=1
fi

system="$(nix eval --raw --impure --expr 'builtins.currentSystem')"
toolchain_names="$(nix eval --json ".#lib.operatorToolchain" --apply "f: map (p: p.pname or p.name) (f \"$system\")" 2>/dev/null || true)"
for tool in opentofu jq just nixos-anywhere nixos-rebuild; do
	if printf '%s' "$toolchain_names" | grep -q "\"$tool"; then
		echo "ok: the operator toolchain carries $tool"
	else
		echo "FAIL: the operator toolchain is missing $tool"
		fail=1
	fi
done

flake_outputs="$(nix flake show --json 2>/dev/null || true)"
host_count="$(printf '%s' "$flake_outputs" | jq ".nixosConfigurations // {} | length" 2>/dev/null || true)"
if [ -z "$flake_outputs" ] || [ -z "$host_count" ]; then
	echo "FAIL: the flake outputs did not evaluate; run 'nix flake show' to see the error"
	fail=1
elif [ "$host_count" = "0" ]; then
	echo "ok: forge declares no concrete host"
else
	echo "FAIL: forge declares a concrete host; it must stay generic and declare none"
	fail=1
fi

exit $fail
