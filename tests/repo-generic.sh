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
for tool in opentofu jq just nixos-anywhere nixos-rebuild sops age ssh-to-age; do
	if printf '%s' "$toolchain_names" | grep -q "\"$tool"; then
		echo "ok: the operator toolchain carries $tool"
	else
		echo "FAIL: the operator toolchain is missing $tool"
		fail=1
	fi
done

host_names="$(nix eval --json --impure --expr "builtins.attrNames ((builtins.getFlake \"git+file://$PWD\").nixosConfigurations or { })" 2>/dev/null || true)"
if [ -z "$host_names" ]; then
	echo "FAIL: the flake outputs did not evaluate; run 'nix eval .#lib' to see the error"
	fail=1
elif [ "$host_names" = "[]" ]; then
	echo "ok: forge declares no concrete host"
else
	echo "FAIL: forge declares a concrete host; it must stay generic and declare none"
	fail=1
fi

vm_tests="$(nix eval --json ".#vmTests.x86_64-linux" --apply builtins.attrNames 2>/dev/null | jq -r 'sort | join(" ")' || true)"
expected_vm_tests="automatic-dispatch deploy-keeps-workloads github-app run-directories runtime-toolset workload-devshell workload-sandbox"
if [ "$vm_tests" = "$expected_vm_tests" ]; then
	echo "ok: vmTests lists the 7 VM tests by name"
else
	echo "FAIL: vmTests.x86_64-linux lists '$vm_tests', expected '$expected_vm_tests'"
	fail=1
fi

workflow=.github/workflows/ci.yml

pinned_nix="$(sed -n 's|^[[:space:]]*install_url:[[:space:]]*https://releases.nixos.org/nix/nix-\([0-9][0-9.]*\)/install[[:space:]]*$|\1|p' "$workflow" | sort -u)"
dev_shell_nix="$(nix develop --command nix --version 2>/dev/null | sed -n 's/^nix (Nix) //p')"
if [ -n "$pinned_nix" ] && [ "$pinned_nix" = "$dev_shell_nix" ]; then
	echo "ok: CI pins Nix $pinned_nix, the dev shell's version"
else
	echo "FAIL: CI pins Nix '${pinned_nix:-none}' but the dev shell's nix is '${dev_shell_nix:-unknown}'; move install_url in $workflow to match"
	fail=1
fi

if grep -qi determinate "$workflow"; then
	echo "FAIL: CI must not install Determinate Nix"
	fail=1
else
	echo "ok: CI does not install Determinate Nix"
fi

expected_timeouts='changes=5
check-no-vm=15
vm-tests=5
vm-test=15
ci=5'
actual_timeouts="$(awk '
	/^jobs:/ { in_jobs = 1; next }
	in_jobs && /^[^[:space:]]/ { in_jobs = 0 }
	in_jobs && /^  [a-z][a-z-]*:[[:space:]]*$/ { if (job != "") print job "=" (timeout == "" ? "none" : timeout); job = $1; sub(/:$/, "", job); timeout = ""; next }
	in_jobs && /^    timeout-minutes:/ { timeout = $2 }
	END { if (job != "") print job "=" (timeout == "" ? "none" : timeout) }
' "$workflow")"
if [ "$actual_timeouts" = "$expected_timeouts" ]; then
	echo "ok: every CI job sets its timeout"
else
	echo "FAIL: CI job timeouts differ from the expected ones"
	diff <(printf '%s\n' "$expected_timeouts") <(printf '%s\n' "$actual_timeouts") || true
	fail=1
fi

exit $fail
