: "${FORGE_PULL_DEPLOY_REPOSITORY:?}"
: "${FORGE_PULL_DEPLOY_REMOTE:?}"
: "${FORGE_PULL_DEPLOY_API:?}"
: "${FORGE_PULL_DEPLOY_HOSTNAME:?}"
: "${FORGE_PULL_DEPLOY_INTERVAL:?}"
: "${FORGE_PULL_DEPLOY_STATUS_FILE:?}"
: "${FORGE_GITHUB_APP_ID:?}"
: "${FORGE_GITHUB_APP_PRIVATE_KEY_FILE:?}"
: "${STATE_DIRECTORY:?}"

repository="$FORGE_PULL_DEPLOY_REPOSITORY"
name="${repository#*/}"
running_file="$STATE_DIRECTORY/running"
system_file="$STATE_DIRECTORY/system"
forge_file="$STATE_DIRECTORY/forge.json"
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

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

app_jwt() {
  local now header payload signature
  now="$(date +%s)"
  header="$(printf '{"alg":"RS256","typ":"JWT"}' | base64url)"
  payload="$(jq -cn --argjson iat "$((now - 60))" --argjson exp "$((now + 540))" --arg iss "$FORGE_GITHUB_APP_ID" '{iat: $iat, exp: $exp, iss: $iss}' | base64url)"
  signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$FORGE_GITHUB_APP_PRIVATE_KEY_FILE" -binary | base64url)"
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

github() {
  local token="$1" method="$2" path="$3"
  shift 3
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -fsS --config - -X "$method" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$@" "$FORGE_PULL_DEPLOY_API$path"
}

mint_token() {
  local jwt installation body
  jwt="$(app_jwt)" || return 1
  installation="$(github "$jwt" GET "/repos/$repository/installation" | jq -er '.id')" || return 1
  body="$(jq -cn --arg name "$name" '{repositories: [$name], permissions: {contents: "read"}}')"
  github "$jwt" POST "/app/installations/$installation/access_tokens" -H 'Content-Type: application/json' -d "$body" | jq -er '.token'
}

authed_git() {
  local token="$1" credentials
  shift
  credentials="$(printf 'x-access-token:%s' "$token" | openssl base64 -A)"
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $credentials" git "$@"
}

read_forge() {
  forge_info=""
  if [ -n "$running" ] && [ -f "$forge_file" ]; then
    forge_info="$(jq -c --arg running "$running" 'select(.running == $running)' "$forge_file" 2>/dev/null)" || forge_info=""
  fi
  forge="$(jq -r '.rev // empty' <<< "$forge_info")"
}

write_forge() {
  local checkout="$1" commit="$2" lock
  lock="$(jq -c '(.nodes.forge // {}) as $forge | {rev: $forge.locked.rev, type: $forge.locked.type, owner: $forge.locked.owner, repo: $forge.locked.repo, ref: $forge.original.ref}' "$checkout/flake.lock" 2>/dev/null)" || lock="null"
  printf '%s\n' "$lock" | jq -c --arg running "$commit" '(. // {}) + {running: $running}' > "$forge_file"
}

backfill_forge() {
  local token="$1" checkout
  [ -n "$running" ] || return 0
  read_forge
  [ -z "$forge_info" ] || return 0
  checkout="$(mktemp -d "$STATE_DIRECTORY/checkout.XXXXXX")" || return 0
  if authed_git "$token" clone --quiet --depth 1 --branch main "$FORGE_PULL_DEPLOY_REMOTE" "$checkout" &&
    [ "$(git -C "$checkout" rev-parse HEAD)" = "$running" ]; then
    write_forge "$checkout" "$running" || true
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
  [[ -z $ref || $ref =~ ^[A-Za-z0-9_./-]+$ ]] || return 0
  api="/repos/$owner/$repo"
  sha="$(github "$current_token" GET "$api/commits/${ref:-HEAD}" | jq -er '.sha')" || return 0
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 0
  ahead="$(github "$current_token" GET "$api/compare/$forge...$sha" | jq -er '.ahead_by')" || return 0
  [[ $ahead =~ ^[0-9]+$ ]] || return 0
  upstream="$owner/$repo"
  upstream_head="$sha"
  behind="$ahead"
}

record_status() {
  local staged
  read_forge
  look_up_upstream
  staged="$(mktemp "$FORGE_PULL_DEPLOY_STATUS_FILE.XXXXXX")" || return 1
  jq -n --arg running "$running" --arg head "$head" --arg error "$failure" --arg forge "$forge" --arg upstream "$upstream" --arg upstream_head "$upstream_head" --arg behind "$behind" \
    'def known: if . == "" then null else . end; {running: ($running | known), head: ($head | known), error: ($error | known), forge: ($forge | known), upstream: ($upstream | known), upstreamHead: ($upstream_head | known), behind: ($behind | known | if . == null then null else tonumber end)}' > "$staged" || return 1
  chmod 0644 "$staged" || return 1
  mv "$staged" "$FORGE_PULL_DEPLOY_STATUS_FILE"
}

running_commit() {
  if [ -f "$running_file" ] && [ -f "$system_file" ] && [ "$(< "$system_file")" = "$(readlink -f /run/current-system)" ]; then
    cat "$running_file"
  fi
}

poll() {
  local token checkout output listing
  running="$(running_commit)" || return 1
  token="$(mint_token)" || return 1
  current_token="$token"
  listing="$(authed_git "$token" ls-remote "$FORGE_PULL_DEPLOY_REMOTE" refs/heads/main)" || return 1
  head="$(cut -f1 <<< "$listing")"
  if [ -z "$head" ]; then
    echo "forge-pull-deploy: $FORGE_PULL_DEPLOY_REMOTE has no main branch" >&2
    return 1
  fi
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
  echo "forge-pull-deploy: switching to $head"
  if output="$(nixos-rebuild switch --no-reexec --flake "$checkout#$FORGE_PULL_DEPLOY_HOSTNAME" 2>&1)"; then
    write_forge "$checkout" "$head" || true
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
