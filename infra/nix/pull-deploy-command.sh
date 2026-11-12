: "${FORGE_PULL_DEPLOY_REPOSITORY:?}"
: "${FORGE_PULL_DEPLOY_REMOTE:?}"
: "${FORGE_PULL_DEPLOY_API:?}"
: "${FORGE_PULL_DEPLOY_UPSTREAM:?}"
: "${FORGE_PULL_DEPLOY_HOSTNAME:?}"
: "${FORGE_PULL_DEPLOY_INTERVAL:?}"
: "${FORGE_PULL_DEPLOY_STATUS_FILE:?}"
: "${FORGE_GITHUB_BOX_APP_ID:?}"
: "${FORGE_GITHUB_BOX_APP_PRIVATE_KEY_FILE:?}"
: "${STATE_DIRECTORY:?}"

repository="$FORGE_PULL_DEPLOY_REPOSITORY"
name="${repository#*/}"
running_file="$STATE_DIRECTORY/running"
system_file="$STATE_DIRECTORY/system"
forge_file="$STATE_DIRECTORY/forge.json"
main_lock_file="$STATE_DIRECTORY/main-lock.json"
dispatched_file="$STATE_DIRECTORY/dispatched"
bump_workflow="forge-bump.yml"
switched=3

rm -rf "$STATE_DIRECTORY"/checkout.*

running=""
head=""
failed=""
failure=""
current_token=""
forge_info=""
forge=""
upstream=""
upstream_head=""
behind=""
dispatched="$(cat "$dispatched_file" 2>/dev/null)" || dispatched=""
bump_failure=""
main_info=""

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

app_jwt() {
  local now header payload signature
  now="$(date +%s)"
  header="$(printf '{"alg":"RS256","typ":"JWT"}' | base64url)"
  payload="$(jq -cn --argjson iat "$((now - 60))" --argjson exp "$((now + 540))" --arg iss "$FORGE_GITHUB_BOX_APP_ID" '{iat: $iat, exp: $exp, iss: $iss}' | base64url)"
  signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$FORGE_GITHUB_BOX_APP_PRIVATE_KEY_FILE" -binary | base64url)"
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

github() {
  local token="$1" method="$2" path="$3"
  shift 3
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -fsS --max-time 30 --path-as-is --config - -X "$method" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$@" "$FORGE_PULL_DEPLOY_API$path"
}

mint_token() {
  local jwt installation body
  jwt="$(app_jwt)" || return 1
  installation="$(github "$jwt" GET "/repos/$repository/installation" | jq -er '.id')" || return 1
  body="$(jq -cn --arg name "$name" '{repositories: [$name], permissions: {contents: "read", actions: "write"}}')"
  github "$jwt" POST "/app/installations/$installation/access_tokens" -H 'Content-Type: application/json' -d "$body" | jq -er '.token'
}

authed_git() {
  local token="$1" credentials
  shift
  credentials="$(printf 'x-access-token:%s' "$token" | openssl base64 -A)"
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $credentials" git "$@"
}

lock_record() {
  local file="$1" commit="$2" record=""
  if [ -n "$commit" ] && [ -f "$file" ]; then
    record="$(jq -c --arg commit "$commit" 'select(.running == $commit)' "$file" 2>/dev/null)" || record=""
  fi
  printf '%s' "$record"
}

read_forge() {
  forge_info="$(lock_record "$forge_file" "$running")"
  forge="$(jq -r '.rev // empty' <<< "$forge_info")"
}

lock_of() {
  jq -c '(.nodes.forge // {}) as $forge | {rev: $forge.locked.rev, type: $forge.locked.type, owner: $forge.locked.owner, repo: $forge.locked.repo, ref: $forge.original.ref}' "$1/flake.lock" 2>/dev/null || echo null
}

write_lock() {
  local file="$1" lock="$2" commit="$3"
  printf '%s\n' "$lock" | jq -c --arg running "$commit" '(. // {}) + {running: $running}' > "$file"
}

write_forge() {
  write_lock "$forge_file" "$1" "$2"
}

backfill_forge() {
  local token="$1" checkout
  [ -n "$running" ] || return 0
  read_forge
  [ -z "$forge_info" ] || return 0
  checkout="$(mktemp -d "$STATE_DIRECTORY/checkout.XXXXXX")" || return 0
  if authed_git "$token" clone --quiet --depth 1 --branch main "$FORGE_PULL_DEPLOY_REMOTE" "$checkout" &&
    [ "$(git -C "$checkout" rev-parse HEAD)" = "$running" ]; then
    write_forge "$(lock_of "$checkout")" "$running" || true
  fi
  rm -rf "$checkout"
}

look_up_upstream() {
  local kind owner repo ref api sha ahead
  upstream=""
  upstream_head=""
  behind=""
  [[ $forge =~ ^[0-9a-f]{40}$ ]] || return 0
  kind="$(jq -r '.type // empty' <<< "$forge_info")"
  owner="$(jq -r '.owner // empty' <<< "$forge_info")"
  repo="$(jq -r '.repo // empty' <<< "$forge_info")"
  ref="$(jq -r '.ref // empty' <<< "$forge_info")"
  [ "$kind" = github ] || return 0
  [[ $owner =~ ^[A-Za-z0-9_.-]+$ && $repo =~ ^[A-Za-z0-9_.-]+$ ]] || return 0
  [[ $owner != . && $owner != .. && $repo != . && $repo != .. ]] || return 0
  [[ -z $ref || ( $ref =~ ^[A-Za-z0-9_./-]+$ && $ref != /* && $ref != */ && $ref != *//* && $ref != *..* ) ]] || return 0
  api="/repos/$owner/$repo"
  sha="$(github "$current_token" GET "$api/commits/${ref:-HEAD}" | jq -er '.sha')" || return 0
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 0
  ahead="$(github "$current_token" GET "$api/compare/$forge...$sha" | jq -er '.ahead_by')" || return 0
  [[ $ahead =~ ^[0-9]+$ ]] || return 0
  upstream="$owner/$repo"
  upstream_head="$sha"
  behind="$ahead"
}

main_lock() {
  local checkout cloned
  main_info="$(lock_record "$main_lock_file" "$head")"
  [ -z "$main_info" ] || return 0
  main_info="$(lock_record "$forge_file" "$head")"
  [ -z "$main_info" ] || return 0
  checkout="$(mktemp -d "$STATE_DIRECTORY/checkout.XXXXXX")" || return 1
  if ! authed_git "$current_token" clone --quiet --depth 1 --branch main "$FORGE_PULL_DEPLOY_REMOTE" "$checkout"; then
    rm -rf "$checkout"
    return 1
  fi
  cloned="$(git -C "$checkout" rev-parse HEAD)" || cloned=""
  if [ "$cloned" = "$head" ]; then
    write_lock "$main_lock_file" "$(lock_of "$checkout")" "$head" || true
    main_info="$(lock_record "$main_lock_file" "$head")"
  fi
  rm -rf "$checkout"
}

start_bump() {
  local locked kind owner repo ref listing upstream_rev wanted
  main_info=""
  if ! main_lock; then
    bump_failure="could not read the forge input in the lock file on main of $FORGE_PULL_DEPLOY_REMOTE"
    return
  fi
  locked="$(jq -r '.rev // empty' <<< "$main_info")"
  kind="$(jq -r '.type // empty' <<< "$main_info")"
  owner="$(jq -r '.owner // empty' <<< "$main_info")"
  repo="$(jq -r '.repo // empty' <<< "$main_info")"
  ref="$(jq -r '.ref // empty' <<< "$main_info")"
  [[ $locked =~ ^[0-9a-f]{40}$ && $kind = github ]] || return 0
  [[ $owner =~ ^[A-Za-z0-9_.-]+$ && $repo =~ ^[A-Za-z0-9_.-]+$ ]] || return 0
  [[ $owner != . && $owner != .. && $repo != . && $repo != .. ]] || return 0
  [[ -z $ref || ( $ref =~ ^[A-Za-z0-9_./-]+$ && $ref != /* && $ref != */ && $ref != *//* && $ref != *..* ) ]] || return 0
  wanted="${ref:+refs/heads/}${ref:-HEAD}"
  if ! listing="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$FORGE_PULL_DEPLOY_UPSTREAM/$owner/$repo.git" "$wanted" 2>&1)"; then
    printf 'forge-pull-deploy: git ls-remote said:\n%s\n' "$(tail -n 5 <<< "$listing")" >&2
    bump_failure="could not look up the head of $owner/$repo"
    return
  fi
  upstream_rev="$(awk -v wanted="$wanted" '$1 ~ /^[0-9a-f]{40}$/ && $2 == wanted {print $1; exit}' <<< "$listing")"
  if [ -z "$upstream_rev" ]; then
    bump_failure="$owner/$repo has no ${ref:-HEAD} to look up"
    return
  fi
  if [ "$upstream_rev" = "$locked" ] || [ "$upstream_rev" = "$dispatched" ]; then
    return 0
  fi
  if ! github "$current_token" POST "/repos/$repository/actions/workflows/$bump_workflow/dispatches" -H 'Content-Type: application/json' -d '{"ref":"main"}' > /dev/null; then
    bump_failure="could not start the forge bump for $upstream_rev"
    return
  fi
  dispatched="$upstream_rev"
  printf '%s\n' "$dispatched" > "$dispatched_file" || true
  echo "forge-pull-deploy: started the forge bump for $upstream_rev"
}

bump() {
  dispatched="$(cat "$dispatched_file" 2>/dev/null)" || dispatched=""
  bump_failure=""
  start_bump
  if [ -n "$bump_failure" ]; then
    echo "forge-pull-deploy: $bump_failure" >&2
  fi
}

record_status() {
  local staged
  read_forge
  look_up_upstream
  staged="$(mktemp "$FORGE_PULL_DEPLOY_STATUS_FILE.XXXXXX")" || return 1
  jq -n --arg running "$running" --arg head "$head" --arg error "$failure" --arg forge "$forge" --arg upstream "$upstream" --arg upstream_head "$upstream_head" --arg behind "$behind" --arg dispatched "$dispatched" --arg bump_error "$bump_failure" \
    'def known: if . == "" then null else . end; {running: ($running | known), head: ($head | known), error: ($error | known), dispatched: ($dispatched | known), bumpError: ($bump_error | known), forge: ($forge | known), upstream: ($upstream | known), upstreamHead: ($upstream_head | known), behind: ($behind | known | if . == null then null else tonumber end)}' > "$staged" || return 1
  chmod 0644 "$staged" || return 1
  mv "$staged" "$FORGE_PULL_DEPLOY_STATUS_FILE"
}

running_commit() {
  if [ -f "$running_file" ] && [ -f "$system_file" ] && [ "$(< "$system_file")" = "$(readlink -f /run/current-system)" ]; then
    cat "$running_file"
  fi
}

poll() {
  local token checkout output listing lock
  running="$(running_commit)" || return 1
  token="$(mint_token)" || return 1
  current_token="$token"
  listing="$(authed_git "$token" ls-remote "$FORGE_PULL_DEPLOY_REMOTE" refs/heads/main)" || return 1
  head="$(cut -f1 <<< "$listing")"
  if [ -z "$head" ]; then
    echo "forge-pull-deploy: $FORGE_PULL_DEPLOY_REMOTE has no main branch" >&2
    return 1
  fi
  bump
  if [ "$head" = "$running" ]; then
    failure=""
    backfill_forge "$token"
    record_status
    return
  fi
  if [ "$head" = "$failed" ]; then
    record_status
    return
  fi
  checkout="$(mktemp -d "$STATE_DIRECTORY/checkout.XXXXXX")" || return 1
  if ! authed_git "$token" clone --quiet --depth 1 --branch main "$FORGE_PULL_DEPLOY_REMOTE" "$checkout"; then
    rm -rf "$checkout"
    return 1
  fi
  if ! head="$(git -C "$checkout" rev-parse HEAD)"; then
    rm -rf "$checkout"
    return 1
  fi
  if [ "$head" = "$running" ] || [ "$head" = "$failed" ]; then
    rm -rf "$checkout"
    record_status
    return
  fi
  lock="$(lock_of "$checkout")"
  echo "forge-pull-deploy: switching to $head"
  if output="$(nixos-rebuild switch --no-reexec --flake "$checkout#$FORGE_PULL_DEPLOY_HOSTNAME" 2>&1)"; then
    write_forge "$lock" "$head" || true
    rm -rf "$checkout"
    { printf '%s\n' "$head" > "$running_file" && readlink -f /run/current-system > "$system_file"; } || return 1
    running="$head"
    failure=""
    record_status
    echo "forge-pull-deploy: switched to $head"
    return "$switched"
  fi
  rm -rf "$checkout"
  printf '%s\n' "$output" >&2
  failed="$head"
  failure="$(printf '%s\n' "$output" | tail -n 20 | tail -c 2000)"
  record_status
}

while true; do
  status=0
  poll || status=$?
  case "$status" in
    0) ;;
    "$switched") exit 0 ;;
    *) echo "forge-pull-deploy: could not complete a look at $repository, trying again in $FORGE_PULL_DEPLOY_INTERVAL seconds" >&2 ;;
  esac
  sleep "$FORGE_PULL_DEPLOY_INTERVAL"
done
