#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
checks="$forge/scripts/checks.sh"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT
system="$(nix eval --raw --impure --expr builtins.currentSystem)"

fail=0

write_flake() {
	{
		cat <<EOF
{
  outputs = _: {
    checks.$system = let
      derivationOf = script: name: features: derivation ({ inherit name; system = "$system"; builder = "/bin/sh"; args = [ "-c" script ]; } // (if features == [ ] then { } else { requiredSystemFeatures = features; }));
      check = derivationOf "echo > \$out";
      broken = derivationOf "exit 1";
    in {
EOF
		printf '      %s\n' "$@"
		printf '    };\n  };\n}\n'
	} >"$scratch/flake.nix"
}

assert_set() {
	local description="$1" selection="$2" expected="$3" actual
	if ! actual="$(FORGE_FLAKE="path:$scratch" "$checks" list "$selection" "$system" | sort | paste -sd ' ' -)"; then
		echo "FAIL: $description: the selection failed"
		fail=1
	elif [ "$actual" = "$expected" ]; then
		echo "ok: $description"
	else
		echo "FAIL: $description: expected '$expected', got '$actual'"
		fail=1
	fi
}

assert_build() {
	local description="$1" selection="$2" expected="$3" actual=pass
	FORGE_FLAKE="path:$scratch" "$checks" build "$selection" "$system" >/dev/null 2>&1 || actual=fail
	if [ "$actual" = "$expected" ]; then
		echo "ok: $description"
	else
		echo "FAIL: $description: expected the build to $expected, but it did not"
		fail=1
	fi
}

fixture=(
	'unit = check "unit" [ ];'
	'parallel = check "parallel" [ "big-parallel" ];'
	'kvm-only = check "kvm-only" [ "kvm" ];'
	'nixos-test-only = check "nixos-test-only" [ "nixos-test" ];'
	'vm = check "vm-test-run-vm" [ "kvm" "nixos-test" ];'
)

write_flake "${fixture[@]}"

assert_set "the VM set is exactly the checks requiring kvm or nixos-test" vm "kvm-only nixos-test-only vm"
assert_set "the check-no-vm set is every other check" no-vm "parallel unit"

write_flake "${fixture[@]}" 'added-vm = check "vm-test-run-added-vm" [ "kvm" "nixos-test" ];'

assert_set "a newly added VM test joins the VM set" vm "added-vm kvm-only nixos-test-only vm"
assert_set "a newly added VM test stays out of the check-no-vm set" no-vm "parallel unit"

write_flake 'unit = check "unit" [ ];' 'vm = broken "vm-test-run-vm" [ "kvm" "nixos-test" ];'

assert_build "building the check-no-vm set never attempts a VM test" no-vm pass

write_flake 'unit = broken "unit" [ ];' 'vm = check "vm-test-run-vm" [ "kvm" "nixos-test" ];'

assert_build "building the check-no-vm set builds every other check" no-vm fail

exit $fail
