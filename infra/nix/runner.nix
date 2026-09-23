{
  buildNpmPackage,
  makeWrapper,
  nodejs,
}:
buildNpmPackage {
  pname = "forge-runner";
  version = "0.0.0";

  src = ../../runtime;

  npmDepsHash = "sha256-skBWI035YYigBNjzDSx9KNz7cSrvXcEZMVRMut8/V80=";

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
    runHook postInstall
  '';

  meta = {
    description = "Forge workload runner: runs one worker headlessly and records the run.";
    mainProgram = "forge-run";
    platforms = nodejs.meta.platforms;
  };
}
