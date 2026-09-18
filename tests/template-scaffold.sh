#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

override="--override-input forge path:$forge"
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
if FORGE_NIX_FLAGS="$override" bash "$work/tests/divergence-guard.sh" >"$work/guard.log" 2>&1; then
	echo "ok: divergence guard passed (built keys == planned keys == config.json)"
else
	echo "FAIL: divergence guard failed on a filled config"
	tail -20 "$work/guard.log"
	fail=1
fi

echo "==> case: a missing config.json fails loudly, with no example fallback"
scaffold
git -C "$work" add -A
if (cd "$work" && nix flake check $override) >"$work/missing.log" 2>&1; then
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
if (cd "$work" && nix flake check $override) >"$work/placeholder.log" 2>&1; then
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
