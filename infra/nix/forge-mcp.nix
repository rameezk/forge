{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
}:
buildNpmPackage {
  pname = "forge-mcp";
  version = "0.0.0";

  src = lib.fileset.toSource {
    root = ../..;
    fileset = ../../runtime;
  };
  sourceRoot = "source/runtime";

  npmDepsHash = import ./runtime-npm-deps-hash.nix;

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    node --test 'packages/mcp/test/**/*.test.ts'
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --offline --no-audit --no-fund
    mkdir -p "$out/lib/forge-mcp/packages"
    cp -r package.json package-lock.json node_modules "$out/lib/forge-mcp/"
    cp -r packages/shared packages/mcp "$out/lib/forge-mcp/packages/"
    find "$out/lib/forge-mcp/node_modules" -xtype l -delete
    makeWrapper ${nodejs}/bin/node "$out/bin/forge-mcp" \
      --add-flags "$out/lib/forge-mcp/packages/mcp/src/main.ts"
    runHook postInstall
  '';

  meta = {
    description = "Forge's local MCP server: over stdio on the operator's machine, reads what forge is running and why a ticket failed from the box's read-only JSON interface at the box's full tailnet name in FORGE_BOX_ADDRESS, over HTTPS unless the address gives a scheme.";
    mainProgram = "forge-mcp";
    platforms = nodejs.meta.platforms;
  };
}
