#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

guard="${FORGE_BUMP_GUARD:-bash tests/divergence-guard.sh}"
failure_title="The forge bump failed the divergence guard"
drift_title="Forge's operator template has changed"
marker_file=".forge-template-rev"
template_path="templates/operator"
diff_limit=40000

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

open_issue_number() {
	gh issue list --state open --limit 100 --json number,title |
		jq -r --arg title "$1" '[.[] | select(.title == $title)][0].number // empty'
}

close_failure_issue() {
	local number
	number="$(open_issue_number "$failure_title")"
	if [ -n "$number" ]; then
		gh issue close "$number" --comment "$1"
	fi
}

forge_url="$(jq -r '.nodes.forge.locked | if .type == "github" then "https://github.com/\(.owner)/\(.repo)" else .url end' flake.lock)"

clone_forge() {
	if [ ! -d "$scratch/forge" ]; then
		git clone --quiet --bare "$forge_url" "$scratch/forge"
	fi
}

close_drift_issue() {
	local number
	number="$(open_issue_number "$drift_title")"
	if [ -n "$number" ]; then
		gh issue close "$number" --comment "$1"
	fi
}

report_drift() {
	local marker locked
	marker="$(tr -d '[:space:]' <"$marker_file" 2>/dev/null || true)"
	locked="$(jq -r '.nodes.forge.locked.rev' flake.lock)"
	if ! [[ $marker =~ ^[0-9a-f]{40}$ ]]; then
		echo "$marker_file does not hold a forge commit; template drift is not checked"
		return 0
	fi
	if [ "$marker" = "$locked" ]; then
		close_drift_issue "The template copies are synced to the locked \`forge\` commit, ${locked:0:7}."
		return 0
	fi
	if ! clone_forge || ! git -C "$scratch/forge" rev-parse --quiet --verify "$marker^{commit}" >/dev/null ||
		! git -C "$scratch/forge" rev-parse --quiet --verify "$locked^{commit}" >/dev/null; then
		echo "forge's history from ${marker:0:7} to ${locked:0:7} is unavailable; template drift is not checked"
		return 0
	fi
	local files
	files="$(git -C "$scratch/forge" diff --name-only "$marker" "$locked" -- "$template_path")"
	if [ -z "$files" ]; then
		close_drift_issue "Forge's operator template has not changed between ${marker:0:7} and the locked \`forge\` commit, ${locked:0:7}."
		return 0
	fi
	{
		echo "Forge's operator template changed between \`${marker:0:7}\`, the commit \`$marker_file\` records, and \`${locked:0:7}\`, the locked \`forge\` input. The bump never merges template files."
		echo
		echo "Changed files:"
		echo
		sed 's|^|- `|; s|$|`|' <<<"$files"
		echo
		echo "Merge them as the README's Upgrading forge section describes, and move \`$marker_file\` to \`$locked\`. This issue closes on the next bump once it has moved."
		echo
		echo "Upstream diff:"
		echo
		echo '```diff'
		git -C "$scratch/forge" diff "$marker" "$locked" -- "$template_path" | head -c "$diff_limit"
		echo '```'
	} >"$scratch/drift.md"
	local number
	number="$(open_issue_number "$drift_title")"
	if [ -n "$number" ]; then
		gh issue edit "$number" --body-file "$scratch/drift.md"
	else
		gh issue create --title "$drift_title" --body-file "$scratch/drift.md"
	fi
}

forge_input_url="$(sed -n 's/^[[:space:]]*forge\.url[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' flake.nix | head -n 1)"
if [[ $forge_input_url =~ (rev=|/)[0-9a-f]{40}([?#\&].*)?$ ]]; then
	echo "the forge input is pinned to a rev in flake.nix; nothing to bump"
	close_failure_issue "The \`forge\` input is now pinned to a rev in \`flake.nix\`, so the bump no longer moves it."
	report_drift
	exit 0
fi

old_rev="$(jq -r '.nodes.forge.locked.rev' flake.lock)"
nix flake update forge
new_rev="$(jq -r '.nodes.forge.locked.rev' flake.lock)"

if [ "$old_rev" = "$new_rev" ]; then
	echo "forge has not moved from ${old_rev:0:7}; nothing to bump"
	close_failure_issue "The locked \`forge\` input is already at forge's latest commit, ${old_rev:0:7}."
	report_drift
	exit 0
fi

forge_url="$(jq -r '.nodes.forge.locked | if .type == "github" then "https://github.com/\(.owner)/\(.repo)" else .url end' flake.lock)"

guard_log="$scratch/guard.log"
if ! bash -c "$guard" >"$guard_log" 2>&1; then
	git checkout --quiet -- flake.lock
	{
		echo "Moving the locked \`forge\` input from \`${old_rev:0:7}\` to \`${new_rev:0:7}\` fails the divergence guard, so nothing was pushed."
		echo
		echo "Last lines of the guard's output:"
		echo
		echo '```'
		tail -n 40 "$guard_log"
		echo '```'
		echo
		echo "The bump tries again on its next run, and this issue closes once a bump passes."
	} >"$scratch/failure.md"
	number="$(open_issue_number "$failure_title")"
	if [ -n "$number" ]; then
		gh issue edit "$number" --body-file "$scratch/failure.md"
	else
		gh issue create --title "$failure_title" --body-file "$scratch/failure.md"
	fi
	report_drift
	echo "the divergence guard rejected forge ${new_rev:0:7}; nothing pushed" >&2
	exit 1
fi

{
	echo "chore: update forge to ${new_rev:0:7}"
	echo
	if clone_forge; then
		git -C "$scratch/forge" log --format='%s' "$old_rev..$new_rev" || true
	fi
} >"$scratch/message"

git add flake.lock
git commit --quiet --file "$scratch/message"
git push --quiet origin HEAD:main

close_failure_issue "The divergence guard passes on forge ${new_rev:0:7}, which is now on \`main\`."
report_drift
