#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
work="$scratch/operator repo"
keys="$(mktemp -d)"
trap 'rm -rf "$scratch" "$keys"' EXIT

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
	jq --arg k "$real_key" '.sshPublicKeys = [$k] | .hostname = "mybox" | .sshPort = 2222' "$work/config.example.json" >"$work/config.json"
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
	printf '{"openrouter_api_key": "sk-or-v1-scaffold-test", "tailscale_auth_key": "scaffold-test-tailscale-key"}' | encrypt_secret secrets/runtime.yaml
}

hcloud_token="scaffold-test-hetzner-token"
write_operator_secret() {
	jq -n --arg t "$hcloud_token" '{HCLOUD_TOKEN: $t}' | encrypt_secret secrets/operator.yaml
}

pin_host_key() {
	cp "$keys/host_key.pub" "$work/secrets/host.pub"
	printf '%s %s\n' "$(jq -r .hostname "$work/config.json")" "$(cat "$work/secrets/host.pub")" >"$work/known_hosts"
}

fill_operator_repo() {
	fill_config
	fill_recipients
	write_host_secret
	pin_host_key
	write_runtime_secret
	write_operator_secret
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

echo "==> case: a scaffolded repository carries the standup wrapper"
scaffold
if [ -f "$work/justfile" ]; then
	echo "ok: scaffolded repository carries the standup/deploy/teardown command wrapper"
else
	echo "FAIL: scaffolded repository is missing the justfile command wrapper"
	fail=1
fi

echo "==> case: the scaffold ships no plaintext token file"
if [ "$(grep -v '^[[:space:]]*$' "$work/.envrc")" = "use flake" ]; then
	echo "ok: the .envrc only activates the dev shell"
else
	echo "FAIL: the .envrc must only activate the dev shell with 'use flake'"
	fail=1
fi
if [ ! -e "$work/.env" ] && [ ! -e "$work/.env.example" ]; then
	echo "ok: the scaffold ships neither .env nor .env.example"
else
	echo "FAIL: the scaffold ships a plaintext token file (.env or .env.example)"
	fail=1
fi

echo "==> case: the standup, deploy, teardown, and ssh commands resolve without executing, against forge's toolchain"
scaffold
fill_operator_repo
for cmd in standup deploy teardown ssh; do
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
echo "tofu HCLOUD_TOKEN=${HCLOUD_TOKEN:-<unset>} $*" >>"$FAKE_LOG"
case " $* " in *" output "*)
	if [ -n "${FAKE_OUTPUT_ONCE:-}" ] && [ -e "$FAKE_OUTPUT_ONCE" ]; then exit 1; fi
	[ -z "${FAKE_OUTPUT_ONCE:-}" ] || touch "$FAKE_OUTPUT_ONCE"
	echo '{"server_ipv4":{"value":"203.0.113.10"}}'
	;;
esac
case " $* " in *" apply "*)
	if [ -n "${FAKE_BLOCK_APPLY:-}" ]; then
		trap 'sleep 1; echo "tofu apply stopped cleanly" >>"$FAKE_LOG"; exit 1' INT
		touch "$FAKE_BLOCK_APPLY"
		while :; do sleep 0.1; done
	fi
	;;
esac
FAKE
cat >"$fake_bin/ssh" <<'FAKE'
#!/usr/bin/env bash
echo "ssh $*" >>"$FAKE_LOG"
"$REAL_SSH" -F "$HOME/.ssh/config" -G "$@" >"$FAKE_LOG.ssh"
target="$(awk '$1 == "hostname" { print $2 }' "$FAKE_LOG.ssh")"
cp "$FAKE_LOG.ssh" "$FAKE_LOG.ssh.$target"
case " ${FAKE_REACHABLE:-} " in *" $target "*) exit 0 ;; esac
if [ "$target" = "$(cat "$FAKE_LOG.joined" 2>/dev/null)" ]; then
	echo x >>"$FAKE_LOG.probes"
	[ "$(wc -l <"$FAKE_LOG.probes")" -le "${FAKE_JOIN_AFTER:-0}" ] || exit 0
fi
exit 255
FAKE
cat >"$fake_bin/nixos-rebuild" <<'FAKE'
#!/usr/bin/env bash
echo "nixos-rebuild $*" >>"$FAKE_LOG"
eval "sshopts=($NIX_SSHOPTS)"
while [ $# -gt 0 ]; do
	if [ "$1" = --target-host ]; then "$REAL_SSH" -F "$HOME/.ssh/config" -G "${sshopts[@]}" "$2" >"$FAKE_LOG.ssh"; fi
	shift
done
FAKE
cat >"$fake_bin/nixos-anywhere" <<'FAKE'
#!/usr/bin/env bash
echo "nixos-anywhere HCLOUD_TOKEN=${HCLOUD_TOKEN:-<unset>} $*" >>"$FAKE_LOG"
while [ $# -gt 0 ]; do
	if [ "$1" = --extra-files ]; then cp -Rp "$2" "$FAKE_CAPTURE"; fi
	if [ "$1" = --flake ] && [ -z "${FAKE_NEVER_JOINS:-}" ]; then echo "${2#.#}" >"$FAKE_LOG.joined"; fi
	shift
done
FAKE
chmod +x "$fake_bin"/*
fake_home="$keys/home"
mkdir -p "$fake_home/.ssh"
user_known_hosts="$(printf '203.0.113.10 %s\n[203.0.113.10]:2222 %s\n' "$(cat "$keys/host_key.pub")" "$(cat "$keys/host_key.pub")")"
printf '%s\n' "$user_known_hosts" >"$fake_home/.ssh/known_hosts"
cat >"$fake_home/.ssh/config" <<'CONFIG'
ControlMaster auto
ControlPath ~/.ssh/cm-%C
KnownHostsCommand /bin/echo %H
GlobalKnownHostsFile ~/.ssh/global_known_hosts
UpdateHostKeys yes
CONFIG
nix_cache="${XDG_CACHE_HOME:-$HOME/.cache}"
real_ssh="$(PATH="$toolchain_path" command -v ssh)"

just_with_fakes() {
	rm -rf "$keys/capture" "$keys/fake.log"*
	touch "$keys/fake.log"
	(cd "$work" && env -u HCLOUD_TOKEN HOME="$fake_home" XDG_CACHE_HOME="$nix_cache" \
		FAKE_LOG="$keys/fake.log" REAL_SSH="$real_ssh" FAKE_CAPTURE="$keys/capture" PATH="$fake_bin:$toolchain_path" just "$@")
}

every_tofu_call_holds_the_token() {
	local expected
	for expected in "$@"; do
		grep -q "^tofu .* ${expected}" "$keys/fake.log" || return 1
	done
	! grep "^tofu " "$keys/fake.log" | grep -vq "^tofu HCLOUD_TOKEN=${hcloud_token} "
}

pinned_to_repository() {
	local resolved="$1" target="$2"
	grep -qx "hostkeyalias mybox" "$resolved" &&
		grep -qx "userknownhostsfile $(cd "$work" && pwd -P)/known_hosts" "$resolved" &&
		grep -qx "stricthostkeychecking true" "$resolved" &&
		grep -qx "hostname $target" "$resolved" &&
		grep -qx "user forge" "$resolved" &&
		grep -qx "port 2222" "$resolved" &&
		grep -qx "globalknownhostsfile /dev/null" "$resolved" &&
		grep -qx "updatehostkeys false" "$resolved" &&
		! grep -q "^knownhostscommand " "$resolved"
}

never_multiplexed() {
	grep -qx "controlmaster false" "$1" && ! grep -q "^controlpath " "$1"
}

echo "==> case: just ssh connects to the box pinned to the repository's host key"
scaffold
fill_operator_repo
(cd "$work" && nix flake lock "${override[@]}" >/dev/null 2>&1 && git add flake.lock)
just_with_fakes ssh -o ServerAliveInterval=30 uptime >"$work/ssh.log" 2>&1 || true
if [ -f "$keys/fake.log.ssh" ] && pinned_to_repository "$keys/fake.log.ssh" mybox && never_multiplexed "$keys/fake.log.ssh" &&
	grep -qx "serveraliveinterval 30" "$keys/fake.log.ssh" && grep -q "^ssh .* uptime$" "$keys/fake.log"; then
	echo "ok: just ssh connects over the tailnet to the box's hostname as the admin user, with the hostname alias, only the repository known_hosts, strict checking and no shared connection, passing extra arguments through"
else
	echo "FAIL: just ssh did not connect over the tailnet pinned to the repository's host key with extra arguments passed through"
	tail -10 "$work/ssh.log"
	cat "$keys/fake.log"; grep -iE "hostkeyalias|knownhosts|stricthostkeychecking|^control|^hostname|^user |^port |serveralive" "$keys/fake.log.ssh"
	fail=1
fi

echo "==> case: deploy connects to the box over the tailnet pinned to the repository's host key"
if just_with_fakes deploy >"$work/deploy.log" 2>&1 && pinned_to_repository "$keys/fake.log.ssh" mybox; then
	echo "ok: every SSH hop deploy makes goes to the box's hostname over the tailnet, with the hostname alias, the repository known_hosts and strict checking"
else
	echo "FAIL: deploy's SSH hops do not go over the tailnet pinned to the repository's host key"
	tail -10 "$work/deploy.log"
	cat "$keys/fake.log"
	fail=1
fi

echo "==> case: standup injects the decrypted host key at install"
injected="$keys/capture/etc/ssh/ssh_host_ed25519_key"
if just_with_fakes standup >"$work/standup.log" 2>&1; then
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

echo "==> case: standup's already-installed probes are pinned, and only the pre-install connection is not"
if pinned_to_repository "$keys/fake.log.ssh.mybox" mybox && never_multiplexed "$keys/fake.log.ssh.mybox" &&
	pinned_to_repository "$keys/fake.log.ssh.203.0.113.10" 203.0.113.10 && never_multiplexed "$keys/fake.log.ssh.203.0.113.10" &&
	! grep "^nixos-anywhere " "$keys/fake.log" | grep -qiE "ssh-option|known_hosts|StrictHostKeyChecking"; then
	echo "ok: the probes over the tailnet and the public IP use the hostname alias, the repository known_hosts and strict checking, and nixos-anywhere keeps its own non-strict defaults"
else
	echo "FAIL: a standup probe is not pinned to the repository's host key, or nixos-anywhere was given host key options"
	cat "$keys/fake.log"
	fail=1
fi

echo "==> case: standup's probe decides only by connecting, never by a failed lookup"
rm -f "$keys/output-read"
if FAKE_OUTPUT_ONCE="$keys/output-read" just_with_fakes standup >"$work/standup-flaky.log" 2>&1 && grep -q "^ssh " "$keys/fake.log"; then
	echo "ok: the probe connects with the address standup already read"
else
	echo "FAIL: the probe gave up before connecting when a repeated address lookup failed"
	tail -10 "$work/standup-flaky.log"
	cat "$keys/fake.log"
	fail=1
fi
just_with_fakes standup >"$work/standup.log" 2>&1

for installed_at in mybox 203.0.113.10; do
	echo "==> case: standup refuses a box an admin login already reaches at $installed_at"
	if FAKE_REACHABLE="$installed_at" just_with_fakes standup >"$work/standup-installed.log" 2>&1; then
		echo "FAIL: standup succeeded against a box already installed at $installed_at"
		cat "$keys/fake.log"
		fail=1
	elif ! grep -q "just deploy" "$work/standup-installed.log" || ! grep -q "just teardown' then 'just standup" "$work/standup-installed.log"; then
		echo "FAIL: standup refused a box installed at $installed_at, but without the deploy or teardown then standup guidance"
		cat "$work/standup-installed.log"
		fail=1
	elif grep -q "^nixos-anywhere " "$keys/fake.log"; then
		echo "FAIL: standup ran nixos-anywhere against a box already installed at $installed_at"
		fail=1
	else
		echo "ok: standup refuses a box installed at $installed_at, pointing to deploy or teardown then standup, and runs no nixos-anywhere"
	fi
done

echo "==> case: standup waits until the installed box is reachable over the tailnet"
if FAKE_JOIN_AFTER=1 just_with_fakes standup >"$work/standup-join.log" 2>&1 &&
	[ "$(sed -n '/^nixos-anywhere /,$p' "$keys/fake.log" | grep -c "^ssh .* forge@mybox .* true$")" = 2 ]; then
	echo "ok: after nixos-anywhere, standup keeps trying SSH over the tailnet and succeeds once it connects"
else
	echo "FAIL: standup did not wait for SSH over the tailnet to succeed after the install"
	tail -10 "$work/standup-join.log"
	cat "$keys/fake.log"
	fail=1
fi

echo "==> case: standup fails loudly when the installed box never joins the tailnet"
if FAKE_NEVER_JOINS=1 just_with_fakes tailnet_join_timeout=1 standup >"$work/standup-no-join.log" 2>&1; then
	echo "FAIL: standup succeeded though the box never became reachable over the tailnet"
	fail=1
elif grep -q "mybox was installed but did not join the tailnet" "$work/standup-no-join.log" && grep -q "^nixos-anywhere " "$keys/fake.log"; then
	echo "ok: once the wait times out, standup fails saying the installed box did not join the tailnet"
else
	echo "FAIL: standup failed, but not by timing out on the tailnet after the install"
	tail -10 "$work/standup-no-join.log"
	fail=1
fi

echo "==> case: standup fails fast, before creating anything, when the tailnet wait is not a whole number of seconds"
if just_with_fakes tailnet_join_timeout=10m standup >"$work/standup-bad-timeout.log" 2>&1; then
	echo "FAIL: standup accepted a tailnet wait that is not a whole number of seconds"
	fail=1
elif grep -q "tailnet_join_timeout" "$work/standup-bad-timeout.log" && ! grep -q "tofu" "$keys/fake.log"; then
	echo "ok: standup stopped before OpenTofu, naming tailnet_join_timeout"
else
	echo "FAIL: standup did not stop before OpenTofu with an error naming tailnet_join_timeout"
	tail -10 "$work/standup-bad-timeout.log"
	cat "$keys/fake.log"
	fail=1
fi

just_with_fakes standup >"$work/standup.log" 2>&1

echo "==> case: standup decrypts the Hetzner token for each OpenTofu call from the operator secrets"
if every_tofu_call_holds_the_token "-chdir=infra/opentofu init" "-chdir=infra/opentofu apply" "-chdir=infra/opentofu output"; then
	echo "ok: every OpenTofu call in standup ran with HCLOUD_TOKEN from secrets/operator.yaml"
else
	echo "FAIL: an OpenTofu call in standup ran without the token from secrets/operator.yaml"
	cat "$keys/fake.log"
	fail=1
fi
if grep -q "^nixos-anywhere HCLOUD_TOKEN=<unset> " "$keys/fake.log"; then
	echo "ok: the token never reached the standup shell, only the OpenTofu calls"
else
	echo "FAIL: the token leaked into the standup shell beyond the OpenTofu calls"
	cat "$keys/fake.log"
	fail=1
fi

echo "==> case: teardown decrypts the Hetzner token for each OpenTofu call from the operator secrets"
if just_with_fakes teardown >"$work/teardown.log" 2>&1 &&
	every_tofu_call_holds_the_token "-chdir=infra/opentofu destroy"; then
	echo "ok: every OpenTofu call in teardown ran with HCLOUD_TOKEN from secrets/operator.yaml"
else
	echo "FAIL: an OpenTofu call in teardown ran without the token from secrets/operator.yaml"
	tail -10 "$work/teardown.log"
	cat "$keys/fake.log"
	fail=1
fi

echo "==> case: neither standup nor teardown touches the user's known_hosts"
if [ "$(cat "$fake_home/.ssh/known_hosts")" = "$user_known_hosts" ]; then
	echo "ok: the user's known_hosts is unchanged after standup and teardown"
else
	echo "FAIL: standup or teardown changed the user's known_hosts"
	diff <(printf '%s\n' "$user_known_hosts") "$fake_home/.ssh/known_hosts"
	fail=1
fi

echo "==> case: interrupting standup waits for OpenTofu to stop cleanly"
blocked="$keys/apply-started"
rm -f "$blocked"
set -m
FAKE_BLOCK_APPLY="$blocked" just_with_fakes standup >"$work/standup-interrupted.log" 2>&1 &
standup_pid=$!
set +m
for _ in $(seq 100); do
	[ -e "$blocked" ] || ! kill -0 "$standup_pid" 2>/dev/null && break
	sleep 0.1
done
if [ ! -e "$blocked" ]; then
	echo "FAIL: standup never reached apply, so it could not be interrupted there"
	cat "$work/standup-interrupted.log"
	kill -INT -- "-$standup_pid" 2>/dev/null || true
	wait "$standup_pid" || true
	fail=1
else
	kill -INT -- "-$standup_pid"
	wait "$standup_pid" || true
	if grep -q "tofu apply stopped cleanly" "$keys/fake.log" && ! grep -q "exit status" "$work/standup-interrupted.log"; then
		echo "ok: Ctrl-C during apply returns only once OpenTofu has stopped, with no stray sops exit line"
	else
		echo "FAIL: Ctrl-C during apply returned before OpenTofu stopped, or sops printed a stray exit line"
		cat "$work/standup-interrupted.log"
		fail=1
	fi
fi

echo "==> case: standup fails fast, before creating anything, when the host key cannot be decrypted"
if SOPS_AGE_KEY_FILE="$keys/stranger.txt" just_with_fakes standup >"$work/standup-locked.log" 2>&1; then
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

echo "==> case: standup fails fast, before creating anything, when known_hosts no longer pins the box"
jq '.hostname = "renamed"' "$work/config.json" >"$work/config.renamed.json"
mv "$work/config.renamed.json" "$work/config.json"
git -C "$work" add -A
if just_with_fakes standup >"$work/standup-drifted.log" 2>&1; then
	echo "FAIL: standup succeeded with a known_hosts entry for a different hostname"
	fail=1
elif ! grep -q "known_hosts" "$work/standup-drifted.log"; then
	echo "FAIL: standup failed, but not with an error naming known_hosts"
	tail -10 "$work/standup-drifted.log"
	fail=1
elif grep -q "tofu" "$keys/fake.log"; then
	echo "FAIL: standup ran OpenTofu before failing on the drifted known_hosts"
	fail=1
else
	echo "ok: standup stopped before OpenTofu, naming known_hosts"
fi

exit $fail
