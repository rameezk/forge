#!/usr/bin/env bash

input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
cd "$(jq -r '.cwd' <<<"$input")" 2>/dev/null || true

[[ "$cmd" == *push* ]] || exit 0

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

check_segment() {
  local seg="$1"
  local -a toks
  read -ra toks <<<"$seg"
  local n=${#toks[@]} i=0

  while (( i < n )) && [[ "${toks[i]}" != "git" ]]; do ((i++)); done
  (( i >= n )) && return
  ((i++))

  while (( i < n )) && [[ "${toks[i]}" == -* ]]; do
    case "${toks[i]}" in
      -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix) ((i++)) ;;
    esac
    ((i++))
  done

  (( i < n )) && [[ "${toks[i]}" == "push" ]] || return
  ((i++))

  local -a pos=()
  local broad=0 t
  while (( i < n )); do
    t="${toks[i]}"; ((i++))
    case "$t" in
      --all|--mirror|--branches|--tags) broad=1 ;;
      -*) : ;;
      *) pos+=("$t") ;;
    esac
  done

  (( broad )) && deny "Pushing with --all/--mirror/--tags is blocked (it can push main/master). Push a specific branch and open a PR."

  local branch ref
  if (( ${#pos[@]} >= 2 )); then
    ref="${pos[1]}"; branch="${ref##*:}"; branch="${branch#+}"
  else
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  fi

  [[ -z "$branch" || "$branch" == "HEAD" ]] && deny "Could not determine the target branch for this push; blocked as a precaution. Push an explicit non-main branch."
  [[ "$branch" =~ ^(main|master)$ ]] && deny "Pushing to $branch is blocked. Branch and open a PR."
}

segments=$(printf '%s' "$cmd" | tr ';&|' '\n\n\n')
while IFS= read -r seg; do
  check_segment "$seg"
done <<<"$segments"

exit 0
