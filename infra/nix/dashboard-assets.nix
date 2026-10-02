{
  lib,
  runCommand,
  curl,
  forge-runner,
}:
let
  runtime = "${forge-runner}/lib/forge-runtime";
in
runCommand "dashboard-assets"
  {
    nativeBuildInputs = [ curl ];
    meta.description = "Starts the packaged forge-frontend and checks a page links a content-hashed stylesheet that the dashboard serves as the package's Tailwind build, styling the page's classes, with an immutable cache header, that it loads the packaged idiomorph and live client the same way, and that the build-only Tailwind toolchain does not ship.";
  }
  ''
    fail() { echo "$1"; shift; for file in "$@"; do cat "$file"; done; exit 1; }

    [ ! -e ${runtime}/node_modules/@tailwindcss/typography ] && [ ! -e ${runtime}/node_modules/tailwindcss ] && [ ! -e ${runtime}/node_modules/@tailwindcss/cli ] || fail "the packaged runtime ships the build-only Tailwind toolchain"

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
    styles() {
      selector="$(printf '%s' "$1" | sed 's/[^A-Za-z0-9_-]/\\&/g; s/[][\.*^$+?(){}|]/\\&/g')"
      grep -qE "\.$selector([^-A-Za-z0-9_\\\\]|\$)" served.css
    }
    styled=""
    while read -r class; do
      styles "$class" && { styled=$class; break; }
    done < <(grep -o 'class="[^"]*"' page.html | sed 's/^class="//; s/"$//' | tr ' ' '\n' | grep -v '^$' | sort -u)
    [ -n "$styled" ] || fail "the served stylesheet styles none of the Runs page's classes:" page.html
    for rule in \
      '--tw-prose-body:var(--color-fg)' \
      '--tw-prose-links:var(--color-accent-text)' \
      '--tw-prose-pre-bg:var(--color-raised)' \
      'prose-pre\:overflow-x-auto' \
      'prose-table\:my-0' \
      'prose-code\:before\:content-none' \
      'prose-code\:after\:content-none' \
      'blockquote_p\]\:before\:content-none' \
      'blockquote_p\]\:after\:content-none' \
      '\[\&\>div\]\:my-6' \
      '\[\&\>\:first-child\]\:mt-0' \
      '\[\&\>\:last-child\]\:mb-0' \
      'prose-th\:min-w-32' \
      'prose-td\:min-w-32'; do
      grep -qF -- "$rule" served.css || fail "the served stylesheet does not generate the markdown rule $rule"
    done
    [ "$href" = "/assets/dashboard-$(sha256sum served.css | cut -c1-16).css" ] || fail "the stylesheet path $href does not hash its content"

    script() {
      name="$1" source="$2"
      src="$(grep -o "<script src=\"/assets/$name-[^\"]*\" defer>" page.html | sed 's/.*src="//; s/".*//')"
      [ -n "$src" ] || fail "the Runs page loads no deferred, hashed $name script:" page.html
      curl -sf -D "$name-headers.txt" "$base$src" -o "$name.js" || fail "the $name script $src is not served"
      grep -qi '^content-type: text/javascript' "$name-headers.txt" || fail "the $name script is not served as JavaScript:" "$name-headers.txt"
      grep -qi '^cache-control:.*immutable' "$name-headers.txt" || fail "the $name script is not cached as immutable:" "$name-headers.txt"
      cmp -s "$name.js" "$source" || fail "the served $name script is not the packaged $source"
      [ "$src" = "/assets/$name-$(sha256sum "$name.js" | cut -c1-16).js" ] || fail "the $name script path $src does not hash its content"
    }
    script idiomorph ${runtime}/node_modules/idiomorph/dist/idiomorph.min.js
    script live ${runtime}/packages/frontend/assets/live.js

    echo "the packaged dashboard serves its Tailwind-built stylesheet and its live client scripts under content-hashed, immutable paths, without shipping the Tailwind toolchain" > $out
  ''
