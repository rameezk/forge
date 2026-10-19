{
  callPackage,
  forge-runner,
  nodejs,
  runCommand,
}:
runCommand "dashboard-browser-tests"
  {
    env = {
      PLAYWRIGHT_BROWSERS_PATH = callPackage ./playwright-browsers.nix { };
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
    };

    nativeBuildInputs = [ nodejs ];

    meta = {
      description = "Runs the dashboard's Playwright browser tests in Chromium from nixpkgs, against a dashboard serving a real store, with no browser downloaded.";
    };
  }
  ''
    cp -r ${forge-runner.browserTests} runtime
    chmod -R u+w runtime
    cd runtime/packages/frontend
    HOME="$(mktemp -d)" ../../node_modules/.bin/playwright test
    echo "the dashboard's browser tests pass in nixpkgs' Chromium" > $out
  ''
