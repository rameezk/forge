#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

override=(--override-input forge "path:$forge")
real_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRealOperatorKeyForTemplateTest operator@test"
fail=0

scaffold() {
	rm -rf "$work"
	mkdir -p "$work"
	(cd "$work" && nix flake init -t "path:$forge#operator" >/dev/null 2>&1)
	cp -R "$forge/infra/opentofu" "$work/_forge_module"
	perl -pi -e 's{source = "github\.com/rameezk/forge//infra/opentofu\?ref=main"}{source = "../../_forge_module"}' "$work/infra/opentofu/main.tf"
	git -C "$work" init -q
}

echo "==> case: a filled config scaffolds a working operator repository whose two tools agree"
scaffold
jq --arg k "$real_key" '.sshPublicKeys = [$k] | .hostname = "mybox"' "$work/config.example.json" >"$work/config.json"
git -C "$work" add -A
if FORGE_NIX_FLAGS="${override[*]}" bash "$work/tests/divergence-guard.sh" >"$work/guard.log" 2>&1; then
	echo "ok: divergence guard passed (built keys == planned keys == config.json)"
else
	echo "FAIL: divergence guard failed on a filled config"
	tail -20 "$work/guard.log"
	fail=1
fi

echo "==> case: a scaffolded repository carries the self-loading environment and the standup wrapper"
scaffold
if [ -f "$work/.envrc" ]; then
	echo "ok: scaffolded repository carries the .envrc self-loading environment file"
else
	echo "FAIL: scaffolded repository is missing the .envrc self-loading environment file"
	fail=1
fi
if [ -f "$work/justfile" ]; then
	echo "ok: scaffolded repository carries the standup/deploy/teardown command wrapper"
else
	echo "FAIL: scaffolded repository is missing the justfile command wrapper"
	fail=1
fi

echo "==> case: the self-loading environment survives a repository with no token yet"
if grep -q "use flake" "$work/.envrc" && grep -q "dotenv_if_exists .env" "$work/.envrc"; then
	echo "ok: the .envrc activates the dev shell and loads the token tolerantly, unset when absent"
else
	echo "FAIL: the .envrc must use flake and load the token with dotenv_if_exists (tolerant of absence)"
	fail=1
fi
if [ ! -e "$work/.env" ]; then
	echo "ok: a freshly scaffolded repository ships no token file for the env to tolerate"
else
	echo "FAIL: a freshly scaffolded repository unexpectedly ships a .env token file"
	fail=1
fi

echo "==> case: the standup, deploy, and teardown commands resolve without executing, against forge's toolchain"
scaffold
jq --arg k "$real_key" '.sshPublicKeys = [$k] | .hostname = "mybox"' "$work/config.example.json" >"$work/config.json"
git -C "$work" add -A
for cmd in standup deploy teardown; do
	if (cd "$work" && nix develop "${override[@]}" -c just -n "$cmd") >"$work/$cmd.log" 2>&1; then
		echo "ok: '$cmd' resolves cleanly against the forge-sourced toolchain, without executing"
	else
		echo "FAIL: '$cmd' did not resolve against the toolchain"
		tail -20 "$work/$cmd.log"
		fail=1
	fi
done

system="$(nix eval --raw --impure --expr 'builtins.currentSystem')"
forge_rebuild="$(nix eval --raw "path:$forge#lib.operatorToolchain" --apply "f: (builtins.head (builtins.filter (p: (p.pname or \"\") == \"nixos-rebuild-ng\") (f \"$system\"))).outPath" 2>/dev/null || true)"
shell_rebuild="$(cd "$work" && nix develop "${override[@]}" -c bash -c 'command -v nixos-rebuild' 2>/dev/null || true)"
if [ -n "$forge_rebuild" ] && [ "$shell_rebuild" = "$forge_rebuild/bin/nixos-rebuild" ]; then
	echo "ok: nixos-rebuild on the operator shell path is forge's toolchain copy"
else
	echo "FAIL: nixos-rebuild on the operator shell path is not forge's toolchain copy"
	echo "  forge toolchain: ${forge_rebuild:-<missing>}"
	echo "  operator shell:  ${shell_rebuild:-<missing>}"
	fail=1
fi

echo "==> case: deploy with no OpenTofu state fails clearly"
if (cd "$work" && nix develop "${override[@]}" -c just deploy) >"$work/deploy-nostate.log" 2>&1; then
	echo "FAIL: deploy succeeded with no OpenTofu state"
	fail=1
elif grep -qi "no box to deploy to" "$work/deploy-nostate.log"; then
	echo "ok: deploy with no state exits non-zero, saying there is no box to deploy to"
else
	echo "FAIL: deploy failed with no state, but not with a clear no-box message"
	tail -10 "$work/deploy-nostate.log"
	fail=1
fi

echo "==> case: the template consumes forge's toolchain rather than pinning any tool itself"
if grep -q "forge.lib.operatorToolchain" "$work/flake.nix"; then
	echo "ok: the operator dev shell consumes forge.lib.operatorToolchain"
else
	echo "FAIL: the operator dev shell does not consume forge.lib.operatorToolchain"
	fail=1
fi
if grep -qE "pkgs\.(opentofu|jq|just|nixos-rebuild)" "$work/flake.nix"; then
	echo "FAIL: the operator flake pins a standup tool independently instead of sourcing it from forge"
	fail=1
else
	echo "ok: the operator flake pins no standup tool independently"
fi

echo "==> case: a missing config.json fails loudly, with no example fallback"
scaffold
git -C "$work" add -A
if (cd "$work" && nix flake check "${override[@]}") >"$work/missing.log" 2>&1; then
	echo "FAIL: the build succeeded with no config.json"
	fail=1
elif grep -qi "config.json" "$work/missing.log"; then
	echo "ok: failed loudly on a missing config.json"
else
	echo "FAIL: the build failed, but not with a clear config.json error"
	tail -10 "$work/missing.log"
	fail=1
fi

echo "==> case: a config left as the placeholder fails loudly"
scaffold
cp "$work/config.example.json" "$work/config.json"
git -C "$work" add -A
if (cd "$work" && nix flake check "${override[@]}") >"$work/placeholder.log" 2>&1; then
	echo "FAIL: the build succeeded with the placeholder config"
	fail=1
elif grep -qi "placeholder" "$work/placeholder.log"; then
	echo "ok: failed loudly on the placeholder config"
else
	echo "FAIL: the build failed, but not with a clear placeholder error"
	tail -10 "$work/placeholder.log"
	fail=1
fi

echo "==> case: the scaffolded flake shows how to declare a worker through the mkHost modules seam"
scaffold
modules_block="$(awk '/# *modules = \[/ { f = 1 } f { print } f && /# *\]; *$/ { exit }' "$work/flake.nix")"
in_modules_block() { printf '%s' "$modules_block" | grep -q "$1"; }
if
	in_modules_block 'forge.runtime.harnesses.pi' &&
		in_modules_block 'forge.runtime.workers' &&
		in_modules_block 'environment.systemPackages = \[ pkgs.pi-coding-agent \]'
then
	echo "ok: one commented mkHost modules list declares a harness and worker and installs the pi harness binary"
else
	echo "FAIL: the scaffolded flake does not show a harness, worker, and pi harness install together in a mkHost modules list"
	fail=1
fi

exit $fail
