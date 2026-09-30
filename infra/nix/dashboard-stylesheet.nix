{
  lib,
  runCommand,
  curl,
  forge-runner,
}:
let
  runtime = "${forge-runner}/lib/forge-runtime";
in
runCommand "dashboard-stylesheet"
  {
    nativeBuildInputs = [ curl ];
    meta.description = "Starts the packaged forge-frontend and checks a page links a content-hashed stylesheet that the dashboard serves as the package's Tailwind build with an immutable cache header, and that the build-only Tailwind toolchain does not ship.";
  }
  ''
    fail() { echo "$1"; shift; for file in "$@"; do cat "$file"; done; exit 1; }

    [ ! -e ${runtime}/node_modules/tailwindcss ] && [ ! -e ${runtime}/node_modules/@tailwindcss/cli ] || fail "the packaged runtime ships the build-only Tailwind toolchain"

    export FORGE_STATE_DIR="$(mktemp -d)"
    for candidate in $(seq 17787 17887); do
      curl -s -o /dev/null "http://127.0.0.1:$candidate/" || { FORGE_FRONTEND_PORT=$candidate; break; }
    done
    [ -n "''${FORGE_FRONTEND_PORT:-}" ] || fail "no free loopback port to start forge-frontend on"
    export FORGE_FRONTEND_PORT
    base="http://127.0.0.1:$FORGE_FRONTEND_PORT"

    ${lib.getExe' forge-runner "forge-frontend"} > frontend.log 2>&1 &
    frontend=$!
    trap 'kill $frontend 2>/dev/null || true' EXIT

    for _ in $(seq 100); do
      curl -sf "$base/" -o page.html && break
      kill -0 $frontend 2>/dev/null || fail "forge-frontend exited:" frontend.log
      sleep 0.1
    done
    [ -s page.html ] || fail "forge-frontend never served the Runs page:" frontend.log

    href="$(grep -o '<link rel="stylesheet" href="[^"]*"' page.html | sed 's/.*href="//; s/"$//')"
    case "$href" in
      /assets/dashboard-*.css) ;;
      *) fail "the Runs page links no hashed stylesheet:" page.html ;;
    esac

    curl -sf -D headers.txt "$base$href" -o served.css || fail "the linked stylesheet $href is not served"
    grep -qi '^content-type: text/css' headers.txt || fail "the stylesheet is not served as CSS:" headers.txt
    grep -qi '^cache-control:.*immutable' headers.txt || fail "the stylesheet is not cached as immutable:" headers.txt
    cmp -s served.css ${runtime}/packages/frontend/dist/dashboard.css || fail "the served stylesheet is not the package's build"
    grep -q 'tailwindcss v4' served.css || fail "the served stylesheet is not built by Tailwind v4"
    [ "$href" = "/assets/dashboard-$(sha256sum served.css | cut -c1-16).css" ] || fail "the stylesheet path $href does not hash its content"

    echo "the packaged dashboard serves its Tailwind-built stylesheet under a content-hashed, immutable path, without shipping the Tailwind toolchain" > $out
  ''
