: "${FORGE_PULL_DEPLOY_REPOSITORY:?}"
: "${FORGE_PULL_DEPLOY_REMOTE:?}"
: "${FORGE_PULL_DEPLOY_API:?}"
: "${FORGE_PULL_DEPLOY_HOSTNAME:?}"
: "${FORGE_PULL_DEPLOY_INTERVAL:?}"
: "${FORGE_PULL_DEPLOY_STATUS_FILE:?}"
: "${FORGE_PULL_DEPLOY_STATUS_OWNER:?}"
: "${FORGE_GITHUB_APP_ID:?}"
: "${FORGE_GITHUB_APP_PRIVATE_KEY_FILE:?}"
: "${STATE_DIRECTORY:?}"

repository="$FORGE_PULL_DEPLOY_REPOSITORY"
name="${repository#*/}"
running_file="$STATE_DIRECTORY/running"

running=""
if [ -f "$running_file" ]; then
  running="$(< "$running_file")"
fi
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
  staged="$(mktemp "$FORGE_PULL_DEPLOY_STATUS_FILE.XXXXXX")"
  jq -n --arg running "$running" --arg head "$head" --arg error "$failure" \
    '{running: ($running | if . == "" then null else . end), head: ($head | if . == "" then null else . end), error: ($error | if . == "" then null else . end)}' > "$staged"
  chown "$FORGE_PULL_DEPLOY_STATUS_OWNER" "$staged"
  chmod 0640 "$staged"
  mv "$staged" "$FORGE_PULL_DEPLOY_STATUS_FILE"
}

build_and_switch() {
  local token="$1" checkout="$2"
  authed_git "$token" clone --quiet --depth 1 --branch main "$FORGE_PULL_DEPLOY_REMOTE" "$checkout" || return 1
  nixos-rebuild switch --flake "$checkout#$FORGE_PULL_DEPLOY_HOSTNAME"
}

poll() {
  local token checkout output
  token="$(mint_token)" || return 1
  head="$(authed_git "$token" ls-remote "$FORGE_PULL_DEPLOY_REMOTE" refs/heads/main | cut -f1)"
  if [ -z "$head" ]; then
    echo "forge-pull-deploy: $FORGE_PULL_DEPLOY_REMOTE has no main branch" >&2
    return 1
  fi
  if [ "$head" = "$running" ]; then
    failure=""
    record_status
    return 0
  fi
  if [ "$head" = "$failed" ]; then
    record_status
    return 0
  fi
  echo "forge-pull-deploy: switching to $head"
  checkout="$(mktemp -d "$STATE_DIRECTORY/checkout.XXXXXX")"
  if output="$(build_and_switch "$token" "$checkout" 2>&1)"; then
    head="$(git -C "$checkout" rev-parse HEAD)"
    rm -rf "$checkout"
    printf '%s\n' "$head" > "$running_file"
    running="$head"
    failure=""
    record_status
    echo "forge-pull-deploy: switched to $head"
    exit 0
  fi
  rm -rf "$checkout"
  printf '%s\n' "$output" >&2
  failed="$head"
  failure="$(printf '%s\n' "$output" | tail -n 20 | tail -c 2000)"
  record_status
}

while true; do
  poll || echo "forge-pull-deploy: could not read $repository, trying again in $FORGE_PULL_DEPLOY_INTERVAL seconds" >&2
  sleep "$FORGE_PULL_DEPLOY_INTERVAL"
done
