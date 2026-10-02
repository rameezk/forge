{
  lib,
  bubblewrap,
  buildNpmPackage,
  git,
  makeWrapper,
  nodejs,
  pi-coding-agent,
  runCommand,
  stdenv,
}:
let
  subagentExtension = "lib/forge-runtime/packages/pi-subagent/src";
  sandboxFlags = lib.optionalString stdenv.hostPlatform.isLinux "--set FORGE_BWRAP ${lib.getExe bubblewrap}";
  piAgentDir = runCommand "pi-agent-dir" { } "mkdir $out";
  piPackage = "${pi-coding-agent}/lib/node_modules/pi-monorepo";
in
buildNpmPackage {
  pname = "forge-runner";
  version = "0.0.0";

  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../runtime
      ../../docs/assets/logo.svg
    ];
  };
  sourceRoot = "source/runtime";

  npmDepsHash = "sha256-OnDcy7dp+twcoZlCGMO6tBusw7uB19bgYUECqICl3nM=";

  nativeBuildInputs = [ makeWrapper ];
  nativeCheckInputs = [ git ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    FORGE_PI_PACKAGE=${piPackage} node --test 'packages/*/test/**/*.test.ts'
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --offline --no-audit --no-fund
    mkdir -p "$out/lib/forge-runtime"
    cp -r package.json package-lock.json packages node_modules "$out/lib/forge-runtime/"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-run" \
      --add-flags "$out/lib/forge-runtime/packages/runner/src/main.ts" \
      --set FORGE_PI_SUBAGENT_EXTENSION "$out/${subagentExtension}" \
      --set FORGE_PI_AGENT_DIR "${piAgentDir}" \
      ${sandboxFlags}
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-dispatch" \
      --add-flags "$out/lib/forge-runtime/packages/runner/src/dispatch-main.ts" \
      --set FORGE_PI_SUBAGENT_EXTENSION "$out/${subagentExtension}" \
      --set FORGE_PI_AGENT_DIR "${piAgentDir}" \
      ${sandboxFlags} \
      --set FORGE_PI_PACKAGE "${piPackage}"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-dispatch-pass" \
      --add-flags "$out/lib/forge-runtime/packages/runner/src/pass-main.ts"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-billing" \
      --add-flags "$out/lib/forge-runtime/packages/runner/src/billing-main.ts"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-frontier" \
      --add-flags "$out/lib/forge-runtime/packages/frontier/src/main.ts"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-frontend" \
      --add-flags "$out/lib/forge-runtime/packages/frontend/src/main.ts"
    runHook postInstall
  '';

  passthru = { inherit subagentExtension piAgentDir piPackage; };

  meta = {
    description = "Forge runtime: runs one worker headlessly (forge-run), dispatches one ticket of a managed repository into a fresh clone (forge-dispatch), starts a dispatch for each forge:ready frontier ticket up to the concurrency limit (forge-dispatch-pass), settles runs' billed cost from OpenRouter (forge-billing), syncs the managed repositories' frontier (forge-frontier), and serves the read-only dashboard (forge-frontend).";
    mainProgram = "forge-run";
    platforms = nodejs.meta.platforms;
  };
}
