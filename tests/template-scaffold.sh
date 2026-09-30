#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
keys="$(mktemp -d)"
trap 'rm -rf "$work" "$keys"' EXIT

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
	git -C "$work" add -A
}

fill_config() {
	jq --arg k "$real_key" '.sshPublicKeys = [$k] | .hostname = "mybox"' "$work/config.example.json" >"$work/config.json"
}

toolchain_path="$(nix develop "path:$forge" -c printenv PATH)"
tool() {
	PATH="$toolchain_path" "$@"
}

export SOPS_AGE_KEY_FILE="$keys/operator.txt"
tool age-keygen -o "$keys/operator.txt" 2>/dev/null
tool age-keygen -o "$keys/stranger.txt" 2>/dev/null
ssh-keygen -q -t ed25519 -N "" -C "" -f "$keys/host_key"
box_recipient="$(tool ssh-to-age <"$keys/host_key.pub")"

fill_recipients() {
	local operator
	operator="$(tool age-keygen -y "$SOPS_AGE_KEY_FILE")"
	perl -pi -e "s/REPLACE_WITH_OPERATOR_AGE_PUBLIC_KEY/$operator/; s/REPLACE_WITH_BOX_AGE_RECIPIENT/$box_recipient/" "$work/.sops.yaml"
}

encrypt_secret() {
	mkdir -p "$work/secrets"
	(cd "$work" && tool sops encrypt --filename-override "$1" --input-type json --output-type yaml --output "$1" /dev/stdin)
}

write_host_secret() {
	jq -Rs '{ssh_host_ed25519_key: .}' "$keys/host_key" | encrypt_secret secrets/host.yaml
}

write_runtime_secret() {
	printf '{"openrouter_api_key": "sk-or-v1-scaffold-test"}' | encrypt_secret secrets/runtime.yaml
}

fill_operator_repo() {
	fill_config
	fill_recipients
	write_host_secret
	write_runtime_secret
	git -C "$work" add -A
}

echo "==> case: a filled operator repository scaffolds a working host whose two tools agree"
scaffold
fill_operator_repo
if FORGE_NIX_FLAGS="${override[*]}" bash "$work/tests/divergence-guard.sh" >"$work/guard.log" 2>&1; then
	echo "ok: divergence guard passed (built keys == planned keys == config.json)"
else
	echo "FAIL: divergence guard failed on a filled operator repository"
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
fill_operator_repo
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

echo "==> case: the scaffold ships placeholder sops recipients and no encrypted files"
scaffold
if grep -q "REPLACE_WITH_OPERATOR_AGE_PUBLIC_KEY" "$work/.sops.yaml" && grep -q "REPLACE_WITH_BOX_AGE_RECIPIENT" "$work/.sops.yaml"; then
	echo "ok: .sops.yaml ships placeholder operator and box recipients"
else
	echo "FAIL: the scaffold does not ship a .sops.yaml with placeholder recipients"
	fail=1
fi
if [ ! -e "$work/secrets" ]; then
	echo "ok: the scaffold ships no encrypted secrets files"
else
	echo "FAIL: the scaffold ships a secrets directory"
	fail=1
fi

echo "==> case: recipients are scoped by path, so the box can read only the runtime secrets"
scaffold
fill_operator_repo
if grep -q "$box_recipient" "$work/secrets/runtime.yaml" && ! grep -q "$box_recipient" "$work/secrets/host.yaml"; then
	echo "ok: the box is a recipient of secrets/runtime.yaml and not of secrets/host.yaml"
else
	echo "FAIL: the box's recipient scoping is wrong across secrets/runtime.yaml and secrets/host.yaml"
	fail=1
fi
printf '{"hcloud_token": "t"}' | encrypt_secret secrets/operator.yaml
if ! grep -q "$box_recipient" "$work/secrets/operator.yaml"; then
	echo "ok: the box is not a recipient of secrets/operator.yaml"
else
	echo "FAIL: the box can decrypt secrets/operator.yaml"
	fail=1
fi

echo "==> case: a missing runtime secrets file fails loudly"
scaffold
fill_config
fill_recipients
write_host_secret
git -C "$work" add -A
if (cd "$work" && nix flake check "${override[@]}") >"$work/no-runtime.log" 2>&1; then
	echo "FAIL: the build succeeded with no runtime secrets file"
	fail=1
elif grep -q "secrets/runtime.yaml" "$work/no-runtime.log"; then
	echo "ok: failed loudly, naming the missing secrets/runtime.yaml"
else
	echo "FAIL: the build failed, but not with an error naming secrets/runtime.yaml"
	tail -10 "$work/no-runtime.log"
	fail=1
fi

echo "==> case: placeholder sops recipients fail loudly"
scaffold
cp "$work/.sops.yaml" "$work/sops.placeholder"
fill_operator_repo
mv "$work/sops.placeholder" "$work/.sops.yaml"
git -C "$work" add -A
if (cd "$work" && nix flake check "${override[@]}") >"$work/no-recipients.log" 2>&1; then
	echo "FAIL: the build succeeded with placeholder sops recipients"
	fail=1
elif grep -q ".sops.yaml" "$work/no-recipients.log" && grep -qi "placeholder" "$work/no-recipients.log"; then
	echo "ok: failed loudly, naming the placeholder recipients in .sops.yaml"
else
	echo "FAIL: the build failed, but not with an error naming the .sops.yaml placeholder"
	tail -10 "$work/no-recipients.log"
	fail=1
fi

fake_bin="$keys/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/tofu" <<'FAKE'
#!/usr/bin/env bash
echo "tofu $*" >>"$FAKE_LOG"
case " $* " in *" output "*) echo '{"server_ipv4":{"value":"203.0.113.10"}}' ;; esac
FAKE
cat >"$fake_bin/ssh" <<'FAKE'
#!/usr/bin/env bash
exit 255
FAKE
cat >"$fake_bin/nixos-anywhere" <<'FAKE'
#!/usr/bin/env bash
echo "nixos-anywhere $*" >>"$FAKE_LOG"
while [ $# -gt 0 ]; do
	if [ "$1" = --extra-files ]; then cp -Rp "$2" "$FAKE_CAPTURE"; fi
	shift
done
FAKE
chmod +x "$fake_bin"/*

standup_with_fakes() {
	rm -rf "$keys/capture" "$keys/fake.log"
	touch "$keys/fake.log"
	(cd "$work" && FAKE_LOG="$keys/fake.log" FAKE_CAPTURE="$keys/capture" PATH="$fake_bin:$toolchain_path" just standup)
}

echo "==> case: standup injects the decrypted host key at install"
scaffold
fill_operator_repo
(cd "$work" && nix flake lock "${override[@]}" >/dev/null 2>&1 && git add flake.lock)
injected="$keys/capture/etc/ssh/ssh_host_ed25519_key"
if standup_with_fakes >"$work/standup.log" 2>&1; then
	if cmp -s "$injected" "$keys/host_key" && [ -n "$(find "$injected" -perm 0600)" ]; then
		echo "ok: standup hands nixos-anywhere the host key at /etc/ssh/ssh_host_ed25519_key, owner-only"
	else
		echo "FAIL: standup did not inject the decrypted host key, owner-only, at /etc/ssh/ssh_host_ed25519_key"
		fail=1
	fi
else
	echo "FAIL: standup failed with a decryptable host key"
	tail -20 "$work/standup.log"
	fail=1
fi

echo "==> case: standup fails fast, before creating anything, when the host key cannot be decrypted"
if SOPS_AGE_KEY_FILE="$keys/stranger.txt" standup_with_fakes >"$work/standup-locked.log" 2>&1; then
	echo "FAIL: standup succeeded without being able to decrypt the host key"
	fail=1
elif ! grep -q "secrets/host.yaml" "$work/standup-locked.log"; then
	echo "FAIL: standup failed, but not with an error naming secrets/host.yaml"
	tail -10 "$work/standup-locked.log"
	fail=1
elif grep -q "tofu" "$keys/fake.log"; then
	echo "FAIL: standup ran OpenTofu before failing on the host key"
	fail=1
else
	echo "ok: standup stopped before OpenTofu, naming secrets/host.yaml"
fi

exit $fail
