{
  buildNpmPackage,
  makeWrapper,
  nodejs,
}:
buildNpmPackage {
  pname = "forge-runner";
  version = "0.0.0";

  src = ../../runtime;

  npmDepsHash = "sha256-Op0vP3OxTrc7OF+pdrW/yJ9dcO45XmFbZXbHrIgUEfw=";

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    node --test packages/*/test/**/*.test.ts
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/forge-runtime"
    cp -r package.json package-lock.json packages node_modules "$out/lib/forge-runtime/"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-run" \
      --add-flags "$out/lib/forge-runtime/packages/runner/src/main.ts"
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-frontend" \
      --add-flags "$out/lib/forge-runtime/packages/frontend/src/main.ts"
    runHook postInstall
  '';

  meta = {
    description = "Forge runtime: runs one worker headlessly (forge-run) and serves the read-only workload dashboard (forge-frontend).";
    mainProgram = "forge-run";
    platforms = nodejs.meta.platforms;
  };
}
