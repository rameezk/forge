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
	echo "ok: scaffolded repository carries the standup/teardown command wrapper"
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

echo "==> case: the standup and teardown commands resolve without executing, against forge's toolchain"
scaffold
jq --arg k "$real_key" '.sshPublicKeys = [$k] | .hostname = "mybox"' "$work/config.example.json" >"$work/config.json"
git -C "$work" add -A
for cmd in standup teardown; do
	if (cd "$work" && nix develop "${override[@]}" -c just -n "$cmd") >"$work/$cmd.log" 2>&1; then
		echo "ok: '$cmd' resolves cleanly against the forge-sourced toolchain, without executing"
	else
		echo "FAIL: '$cmd' did not resolve against the toolchain"
		tail -20 "$work/$cmd.log"
		fail=1
	fi
done

echo "==> case: the template consumes forge's toolchain rather than pinning any tool itself"
if grep -q "forge.lib.operatorToolchain" "$work/flake.nix"; then
	echo "ok: the operator dev shell consumes forge.lib.operatorToolchain"
else
	echo "FAIL: the operator dev shell does not consume forge.lib.operatorToolchain"
	fail=1
fi
if grep -qE "pkgs\.(opentofu|jq|just)" "$work/flake.nix"; then
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

exit $fail
