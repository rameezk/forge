{
  lib,
  runCommand,
  nodejs,
  pi-coding-agent,
}:
runCommand "pi-cli-contract"
  {
    nativeBuildInputs = [ nodejs ];
    meta.description = "Runs the locked pi-coding-agent with the exact argv the runner's pi adapter builds, failing if pi rejects any of it.";
  }
  ''
    export HOME="$TMPDIR"
    node ${./pi-cli-contract.mjs} ${../../runtime/packages/runner/src}/pi.ts ${lib.getExe pi-coding-agent}
    echo "pi-coding-agent ${pi-coding-agent.version} accepts the runner's pi adapter argv" > $out
  ''
