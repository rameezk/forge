{
  buildNpmPackage,
  nodejs,
}:
buildNpmPackage {
  pname = "forge-shared";
  version = "0.0.0";

  src = ../../runtime;

  npmDepsHash = "sha256-skBWI035YYigBNjzDSx9KNz7cSrvXcEZMVRMut8/V80=";

  dontNpmBuild = true;

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    node --test packages/shared/test/*.test.ts
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/forge-shared"
    cp -r package.json packages "$out/lib/forge-shared/"
    runHook postInstall
  '';

  meta = {
    description = "Shared, typed foundation for the forge runtime.";
    platforms = nodejs.meta.platforms;
  };
}
