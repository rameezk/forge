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

host_eval_err="$(mktemp)"
if host_names="$(nix eval --json .#nixosConfigurations --apply "builtins.attrNames" 2>"$host_eval_err")"; then
	if [ "$host_names" = "[]" ]; then
		echo "ok: forge declares no concrete host"
	else
		echo "FAIL: forge declares a concrete host; it must stay generic and declare none"
		fail=1
	fi
elif grep -q "does not provide attribute" "$host_eval_err"; then
	echo "ok: forge declares no concrete host"
else
	echo "FAIL: nixosConfigurations is present but does not evaluate:"
	cat "$host_eval_err"
	fail=1
fi
rm -f "$host_eval_err"

exit $fail
