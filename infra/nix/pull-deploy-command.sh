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
switched=3

rm -rf "$STATE_DIRECTORY"/checkout.*

running=""
head=""
failed=""
failure=""

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

record_status() {
  local staged
  staged="$(mktemp "$FORGE_PULL_DEPLOY_STATUS_FILE.XXXXXX")" || return 1
  jq -n --arg running "$running" --arg head "$head" --arg error "$failure" \
    '{running: ($running | if . == "" then null else . end), head: ($head | if . == "" then null else . end), error: ($error | if . == "" then null else . end)}' > "$staged" || return 1
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
  listing="$(authed_git "$token" ls-remote "$FORGE_PULL_DEPLOY_REMOTE" refs/heads/main)" || return 1
  head="$(cut -f1 <<< "$listing")"
  if [ -z "$head" ]; then
    echo "forge-pull-deploy: $FORGE_PULL_DEPLOY_REMOTE has no main branch" >&2
    return 1
  fi
  if [ "$head" = "$running" ]; then
    failure=""
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
  if output="$(nixos-rebuild switch --flake "$checkout#$FORGE_PULL_DEPLOY_HOSTNAME" 2>&1)"; then
    rm -rf "$checkout"
    printf '%s\n' "$head" > "$running_file"
    readlink -f /run/current-system > "$system_file"
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
