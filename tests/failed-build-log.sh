#!/usr/bin/env bash
set -euo pipefail

scratch="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT
system="$(nix eval --raw --impure --expr builtins.currentSystem)"

cat >"$scratch/flake.nix" <<NIX
{
  outputs = _: {
    checks.$system.noisy = derivation {
      name = "noisy-failure";
      system = "$system";
      builder = "/bin/sh";
      args = [ "-c" "i=1; while [ \\\$i -le 60 ]; do echo build-log-line-\\\$i; i=\\\$((i+1)); done; exit 1" ];
    };
  };
}
NIX

fail=0

if output="$(cd "$scratch" && nix flake check --print-build-logs 2>&1)"; then
	echo "FAIL: a failed build is reported: the check unexpectedly passed"
	fail=1
elif grep -q 'Invalid BuildResult status' <<<"$output"; then
	echo "FAIL: a failed build is reported with its derivation and its full build log: the output has an invalid build result"
	fail=1
elif ! grep -q 'noisy-failure' <<<"$output"; then
	echo "FAIL: a failed build is reported with its derivation and its full build log: the failing derivation is not named"
	fail=1
else
	for line in $(seq 1 60); do
		if ! grep -q "build-log-line-$line\$" <<<"$output"; then
			echo "FAIL: a failed build is reported with its derivation and its full build log: line $line is missing"
			fail=1
			break
		fi
	done
	if [ "$fail" = 0 ]; then
		echo "ok: a failed build is reported with its derivation and its full build log"
	fi
fi

exit $fail
