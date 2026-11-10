#!/usr/bin/env bash
set -euo pipefail

forge="$(git rev-parse --show-toplevel)"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT

upstream="$scratch/forge-upstream"
nixpkgs_stub="$scratch/nixpkgs-stub"
origin="$scratch/origin.git"
work="$scratch/operator"
stubs="$scratch/stubs"
gh_state="$scratch/gh-state"
guard_flag="$scratch/guard-verdict"
fail=0

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

mkdir -p "$stubs" "$gh_state" "$nixpkgs_stub"
echo '[]' >"$gh_state/issues.json"

cat >"$nixpkgs_stub/flake.nix" <<'NIX'
{
  outputs = { self }: { };
}
NIX

mkdir -p "$upstream"
git -C "$upstream" init -q -b main
cat >"$upstream/flake.nix" <<NIX
{
  inputs.nixpkgs.url = "path:$nixpkgs_stub";
  outputs = { self, nixpkgs }: { };
}
NIX

forge_commit() {
	echo "$1" >>"$upstream/changes.txt"
	git -C "$upstream" add -A
	git -C "$upstream" commit -q -m "$1"
	git -C "$upstream" rev-parse HEAD
}

template_commit() {
	mkdir -p "$(dirname "$upstream/templates/operator/$1")"
	echo "$2" >>"$upstream/templates/operator/$1"
	git -C "$upstream" add -A
	git -C "$upstream" commit -q -m "template: $2"
	git -C "$upstream" rev-parse HEAD
}

cat >"$stubs/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
state="$GH_STATE"
issues="$state/issues.json"
echo "$*" >>"$state/calls.log"
sub="$1 $2"
shift 2
case "$sub" in
"issue list")
	jq -c '[.[] | select(.state == "open") | {number, title}]' "$issues"
	;;
"issue create")
	title=""
	while [ $# -gt 0 ]; do
		case "$1" in
		--title) title="$2"; shift 2 ;;
		--body-file) body="$(cat "$2")"; shift 2 ;;
		*) shift ;;
		esac
	done
	number=$(($(jq 'length' "$issues") + 1))
	jq --argjson n "$number" --arg t "$title" --arg b "$body" '. + [{number: $n, title: $t, body: $b, state: "open"}]' "$issues" >"$issues.new"
	mv "$issues.new" "$issues"
	echo "https://github.com/operator/repo/issues/$number"
	;;
"issue edit")
	number="$1"
	shift
	while [ $# -gt 0 ]; do
		case "$1" in
		--body-file) body="$(cat "$2")"; shift 2 ;;
		*) shift ;;
		esac
	done
	jq --argjson n "$number" --arg b "$body" 'map(if .number == $n then .body = $b else . end)' "$issues" >"$issues.new"
	mv "$issues.new" "$issues"
	;;
"issue close")
	number="$1"
	jq --argjson n "$number" 'map(if .number == $n then .state = "closed" else . end)' "$issues" >"$issues.new"
	mv "$issues.new" "$issues"
	;;
*)
	echo "gh stub: unsupported call: $sub $*" >&2
	exit 1
	;;
esac
STUB
chmod +x "$stubs/gh"

cat >"$scratch/guard.sh" <<GUARD
#!/usr/bin/env bash
jq -r '.nodes.forge.locked.rev' flake.lock >"$scratch/guard-saw-rev"
[ "\$(cat "$guard_flag")" = pass ]
GUARD
echo pass >"$guard_flag"

x_commit="$(forge_commit "first change")"

(
	rm -rf "$origin" "$work"
	git init -q --bare -b main "$origin"
	mkdir -p "$work"
	cd "$work"
	nix flake init -t "path:$forge#operator" >/dev/null 2>&1
	perl -pi -e "s{forge\\.url = \"[^\"]*\";}{forge.url = \"git+file://$upstream\";}" flake.nix
	git init -q -b main
	git remote add origin "$origin"
	echo "$x_commit" >.forge-template-rev
	git add -A
	nix flake lock >"$scratch/lock.log" 2>&1 || { cat "$scratch/lock.log"; exit 1; }
	git add -A
	git commit -q -m "initial"
	git push -q origin main
)

run_bump() {
	(cd "$work" && PATH="$stubs:$PATH" GH_STATE="$gh_state" FORGE_BUMP_GUARD="bash $scratch/guard.sh" bash scripts/forge-bump.sh)
}

origin_head() {
	git -C "$origin" rev-parse main
}

echo "==> case: forge moved, the guard passes, one commit lands on main"
forge_commit "second change" >/dev/null
z_commit="$(forge_commit "third change")"
before="$(origin_head)"
run_bump >"$scratch/moved.log" 2>&1
subject="$(git -C "$origin" log -1 --format=%s main)"
body="$(git -C "$origin" log -1 --format=%b main)"
if [ "$(git -C "$origin" rev-list --count "$before..main")" = 1 ] &&
	[ "$subject" = "chore: update forge to ${z_commit:0:7}" ] &&
	[ "$(git -C "$origin" show main:flake.lock | jq -r '.nodes.forge.locked.rev')" = "$z_commit" ] &&
	[ "$(cat "$scratch/guard-saw-rev")" = "$z_commit" ] &&
	grep -qx "second change" <<<"$body" && grep -qx "third change" <<<"$body" && ! grep -q "first change" <<<"$body"; then
	echo "ok: one commit '$subject' pushed, listing the upstream subjects"
else
	echo "FAIL: expected one commit 'chore: update forge to ${z_commit:0:7}' listing the upstream subjects"
	tail -20 "$scratch/moved.log"
	fail=1
fi

echo "==> case: forge moved but its operator template did not, no drift is reported"
if [ "$(jq 'length' "$gh_state/issues.json")" = 0 ]; then
	echo "ok: no drift issue while the operator template is unchanged since the marker"
else
	echo "FAIL: a drift issue was opened although the operator template did not change"
	fail=1
fi

echo "==> case: forge unchanged, no commit is made"
before="$(origin_head)"
unchanged_status=0
run_bump >"$scratch/unchanged.log" 2>&1 || unchanged_status=$?
if [ "$unchanged_status" = 0 ] && [ "$(origin_head)" = "$before" ] && [ "$(git -C "$work" rev-parse HEAD)" = "$before" ]; then
	echo "ok: no commit made while forge has not moved"
else
	echo "FAIL: a commit was made although forge has not moved"
	tail -20 "$scratch/unchanged.log"
	fail=1
fi

open_issues() {
	jq -c '[.[] | select(.state == "open")]' "$gh_state/issues.json"
}

echo "==> case: the guard fails, nothing is pushed and one issue reports it"
rejected_commit="$(forge_commit "change the guard rejects")"
echo fail >"$guard_flag"
before="$(origin_head)"
lock_before="$(cat "$work/flake.lock")"
guard_status=0
run_bump >"$scratch/guard-fails.log" 2>&1 || guard_status=$?
if [ "$guard_status" != 0 ] &&
	[ "$(origin_head)" = "$before" ] &&
	[ "$(git -C "$work" rev-parse HEAD)" = "$before" ] &&
	[ "$(cat "$work/flake.lock")" = "$lock_before" ] &&
	[ "$(open_issues | jq 'length')" = 1 ] &&
	[ "$(open_issues | jq -r '.[0].title')" = "The forge bump failed the divergence guard" ] &&
	open_issues | jq -r '.[0].body' | grep -q "${rejected_commit:0:7}"; then
	echo "ok: nothing pushed, the lock is untouched, and one open issue names the rejected commit"
else
	echo "FAIL: expected a failing bump, nothing pushed, and one open issue naming ${rejected_commit:0:7}"
	tail -20 "$scratch/guard-fails.log"
	fail=1
fi

echo "==> case: the guard fails again, the one issue is updated, not duplicated"
run_bump >"$scratch/guard-fails-again.log" 2>&1 || true
if [ "$(jq 'length' "$gh_state/issues.json")" = 1 ]; then
	echo "ok: still one issue after a second failing bump"
else
	echo "FAIL: a second failing bump opened another issue"
	fail=1
fi

echo "==> case: the guard recovers, the bump lands and the issue closes"
echo pass >"$guard_flag"
before="$(origin_head)"
run_bump >"$scratch/recovers.log" 2>&1 || true
if [ "$(git -C "$origin" rev-list --count "$before..main")" = 1 ] &&
	[ "$(git -C "$origin" show main:flake.lock | jq -r '.nodes.forge.locked.rev')" = "$rejected_commit" ] &&
	[ "$(open_issues | jq 'length')" = 0 ]; then
	echo "ok: the bump landed and the failure issue is closed"
else
	echo "FAIL: expected the bump to land and the failure issue to close"
	tail -20 "$scratch/recovers.log"
	fail=1
fi

drift_title="Forge's operator template has changed"

echo "==> case: the operator template changed since the marker, one issue lists the files and the diff"
template_commit README.md "a new required secret" >/dev/null
drift_commit="$(template_commit scripts/new-script.sh "a new script")"
before="$(origin_head)"
run_bump >"$scratch/drift.log" 2>&1 || true
if [ "$(git -C "$origin" rev-list --count "$before..main")" = 1 ] &&
	[ "$(open_issues | jq 'length')" = 1 ] &&
	[ "$(open_issues | jq -r '.[0].title')" = "$drift_title" ] &&
	open_issues | jq -r '.[0].body' | grep -q "templates/operator/README.md" &&
	open_issues | jq -r '.[0].body' | grep -q "templates/operator/scripts/new-script.sh" &&
	open_issues | jq -r '.[0].body' | grep -q "^+a new required secret$" &&
	open_issues | jq -r '.[0].body' | grep -q "${x_commit:0:7}" &&
	open_issues | jq -r '.[0].body' | grep -q "${drift_commit:0:7}"; then
	echo "ok: one open issue lists the changed template files and the upstream diff"
else
	echo "FAIL: expected one open drift issue listing the changed files and the diff"
	tail -20 "$scratch/drift.log"
	fail=1
fi

echo "==> case: drift is still outstanding, the issue is updated and not duplicated"
newer_commit="$(template_commit justfile "a new recipe")"
run_bump >"$scratch/drift-again.log" 2>&1 || true
if [ "$(open_issues | jq 'length')" = 1 ] && [ "$(jq 'length' "$gh_state/issues.json")" = 2 ] &&
	open_issues | jq -r '.[0].body' | grep -q "templates/operator/justfile" &&
	open_issues | jq -r '.[0].body' | grep -q "${newer_commit:0:7}"; then
	echo "ok: the existing issue was updated and no second issue opened"
else
	echo "FAIL: expected the one drift issue to be updated"
	tail -20 "$scratch/drift-again.log"
	fail=1
fi

echo "==> case: drift is outstanding and forge has not moved, the issue stays open"
run_bump >"$scratch/drift-quiet.log" 2>&1 || true
if [ "$(jq 'length' "$gh_state/issues.json")" = 2 ] && [ "$(open_issues | jq 'length')" = 1 ]; then
	echo "ok: the drift issue stays open and is not duplicated"
else
	echo "FAIL: the drift issue was duplicated or closed with drift outstanding"
	fail=1
fi

echo "==> case: the marker moves to the locked commit, the issue closes"
locked_now="$(jq -r '.nodes.forge.locked.rev' "$work/flake.lock")"
echo "$locked_now" >"$work/.forge-template-rev"
git -C "$work" add -A
git -C "$work" commit -q -m "chore: sync template to ${locked_now:0:7}"
git -C "$work" push -q origin main
run_bump >"$scratch/drift-cleared.log" 2>&1 || true
if [ "$(open_issues | jq 'length')" = 0 ]; then
	echo "ok: the drift issue is closed once the marker catches up"
else
	echo "FAIL: the drift issue stayed open after the marker moved to the locked commit"
	tail -20 "$scratch/drift-cleared.log"
	fail=1
fi

echo "==> case: the marker is empty, no drift is reported"
: >"$work/.forge-template-rev"
template_commit README.md "another change" >/dev/null
git -C "$work" commit -q -am "blank the marker"
git -C "$work" push -q origin main
empty_status=0
run_bump >"$scratch/empty-marker.log" 2>&1 || empty_status=$?
if [ "$empty_status" = 0 ] && [ "$(open_issues | jq 'length')" = 0 ]; then
	echo "ok: an empty marker reports no drift"
else
	echo "FAIL: an empty marker should report no drift"
	tail -20 "$scratch/empty-marker.log"
	fail=1
fi
locked_now="$(jq -r '.nodes.forge.locked.rev' "$work/flake.lock")"
echo "$locked_now" >"$work/.forge-template-rev"
git -C "$work" commit -q -am "restore the marker"
git -C "$work" push -q origin main

echo "==> case: the forge input is pinned to a rev in flake.nix, the lock and main stay put"
forge_commit "change after the pin" >/dev/null
perl -pi -e "s{forge\\.url = \"[^\"]*\";}{forge.url = \"git+file://$upstream?rev=$x_commit\";}" "$work/flake.nix"
git -C "$work" commit -q -am "pin forge"
git -C "$work" push -q origin main
before="$(origin_head)"
lock_before="$(cat "$work/flake.lock")"
pinned_status=0
run_bump >"$scratch/pinned.log" 2>&1 || pinned_status=$?
if [ "$pinned_status" = 0 ] &&
	[ "$(origin_head)" = "$before" ] &&
	[ "$(git -C "$work" rev-parse HEAD)" = "$before" ] &&
	[ "$(cat "$work/flake.lock")" = "$lock_before" ]; then
	echo "ok: a pinned forge input is left alone"
else
	echo "FAIL: the bump touched a forge input pinned in flake.nix"
	tail -20 "$scratch/pinned.log"
	fail=1
fi

echo "==> case: the forge input is pinned in the github form the README documents"
perl -pi -e "s{forge\\.url = \"[^\"]*\";}{forge.url = \"github:rameezk/forge/$x_commit\";}" "$work/flake.nix"
git -C "$work" commit -q -am "pin forge to github"
git -C "$work" push -q origin main
before="$(origin_head)"
lock_before="$(cat "$work/flake.lock")"
github_pin_status=0
run_bump >"$scratch/github-pinned.log" 2>&1 || github_pin_status=$?
if [ "$github_pin_status" = 0 ] &&
	[ "$(origin_head)" = "$before" ] &&
	[ "$(cat "$work/flake.lock")" = "$lock_before" ]; then
	echo "ok: a github:owner/repo/<commit> pin is left alone"
else
	echo "FAIL: the bump touched a forge input pinned as github:owner/repo/<commit>"
	tail -20 "$scratch/github-pinned.log"
	fail=1
fi

echo "==> case: a failure issue still open when the input is pinned is closed"
jq '. + [{number: 99, title: "The forge bump failed the divergence guard", body: "stale", state: "open"}]' "$gh_state/issues.json" >"$gh_state/issues.new"
mv "$gh_state/issues.new" "$gh_state/issues.json"
run_bump >"$scratch/stale-pinned.log" 2>&1 || true
if [ "$(open_issues | jq 'length')" = 0 ]; then
	echo "ok: the stale failure issue is closed"
else
	echo "FAIL: the failure issue stayed open while the input is pinned"
	fail=1
fi

echo "==> case: a failure issue still open when forge has not moved is closed"
perl -pi -e "s{forge\\.url = \"[^\"]*\";}{forge.url = \"git+file://$upstream\";}" "$work/flake.nix"
git -C "$work" commit -q -am "follow forge again"
git -C "$work" push -q origin main
run_bump >"$scratch/follow-again.log" 2>&1 || true
head_after_follow="$(origin_head)"
jq '. + [{number: 98, title: "The forge bump failed the divergence guard", body: "stale", state: "open"}]' "$gh_state/issues.json" >"$gh_state/issues.new"
mv "$gh_state/issues.new" "$gh_state/issues.json"
run_bump >"$scratch/stale-unchanged.log" 2>&1 || true
if [ "$(open_issues | jq 'length')" = 0 ] && [ "$(origin_head)" = "$head_after_follow" ]; then
	echo "ok: the stale failure issue is closed and no commit is made"
else
	echo "FAIL: the failure issue stayed open while forge has not moved"
	fail=1
fi

echo "==> case: forge history was rewritten, the bump still lands with an empty body"
git -C "$upstream" reset -q --hard "$(git -C "$upstream" rev-parse HEAD~1)"
rewritten_commit="$(forge_commit "after the rewrite")"
before="$(origin_head)"
rewrite_status=0
run_bump >"$scratch/rewritten.log" 2>&1 || rewrite_status=$?
if [ "$rewrite_status" = 0 ] &&
	[ "$(git -C "$origin" rev-list --count "$before..main")" = 1 ] &&
	[ "$(git -C "$origin" log -1 --format=%s main)" = "chore: update forge to ${rewritten_commit:0:7}" ] &&
	[ -z "$(git -C "$origin" log -1 --format=%b main)" ]; then
	echo "ok: the bump landed although the locked commit is gone upstream"
else
	echo "FAIL: the bump did not land after forge's history was rewritten"
	tail -20 "$scratch/rewritten.log"
	fail=1
fi

exit $fail
