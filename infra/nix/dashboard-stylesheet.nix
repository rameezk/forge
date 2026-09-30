{
  lib,
  runCommand,
  curl,
  forge-runner,
}:
runCommand "dashboard-stylesheet"
  {
    nativeBuildInputs = [ curl ];
    meta.description = "Starts the packaged forge-frontend and checks a page links a hashed stylesheet that the dashboard serves with the page's styles and an immutable cache header.";
  }
  ''
    export FORGE_STATE_DIR="$(mktemp -d)"
    export FORGE_FRONTEND_PORT=17787
    base="http://127.0.0.1:$FORGE_FRONTEND_PORT"

    ${lib.getExe' forge-runner "forge-frontend"} > frontend.log 2>&1 &
    frontend=$!
    trap 'kill $frontend 2>/dev/null || true' EXIT

    for _ in $(seq 100); do
      curl -sf "$base/" -o page.html && break
      kill -0 $frontend 2>/dev/null || { echo "forge-frontend exited:"; cat frontend.log; exit 1; }
      sleep 0.1
    done
    [ -s page.html ] || { echo "forge-frontend never served the Runs page:"; cat frontend.log; exit 1; }

    href="$(grep -o '<link rel="stylesheet" href="[^"]*"' page.html | sed 's/.*href="//; s/"$//')"
    case "$href" in
      /assets/dashboard-*.css) ;;
      *) echo "the Runs page links no hashed stylesheet:"; cat page.html; exit 1 ;;
    esac

    curl -sf -D headers.txt "$base$href" -o dashboard.css
    grep -qi '^content-type: text/css' headers.txt || { echo "the stylesheet is not served as CSS:"; cat headers.txt; exit 1; }
    grep -qi '^cache-control:.*immutable' headers.txt || { echo "the stylesheet is not cached as immutable:"; cat headers.txt; exit 1; }
    grep -q 'class="site"' page.html || { echo "the Runs page lost its site header:"; cat page.html; exit 1; }
    grep -q 'header\.site' dashboard.css || { echo "the served stylesheet lacks the page's styles:"; cat dashboard.css; exit 1; }

    echo "the packaged dashboard serves its Tailwind-built stylesheet under a hashed, immutable path" > $out
  ''
