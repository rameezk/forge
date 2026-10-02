{
  callPackage,
  forge-runner,
}:
forge-runner.overrideAttrs (old: {
  pname = "dashboard-browser-tests";

  env = (old.env or { }) // {
    PLAYWRIGHT_BROWSERS_PATH = callPackage ./playwright-browsers.nix { };
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
  };

  checkPhase = ''
    runHook preCheck
    HOME="$(mktemp -d)" npm run test:browser -w @forge/frontend
    runHook postCheck
  '';

  installPhase = ''
    echo "the dashboard's browser tests pass in nixpkgs' Chromium" > $out
  '';

  meta = {
    description = "Runs the dashboard's Playwright browser tests in Chromium from nixpkgs, against a dashboard serving a real store, with no browser downloaded.";
  };
})
