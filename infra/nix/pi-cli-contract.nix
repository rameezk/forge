{
  lib,
  runCommand,
  nodejs,
  pi-coding-agent,
  forge-runner,
}:
let
  runtime = "${forge-runner}/lib/forge-runtime";
in
runCommand "pi-cli-contract"
  {
    nativeBuildInputs = [ nodejs ];
    meta.description = "Runs the locked pi-coding-agent with the exact argv the runner's pi adapter builds, loading the runner's subagent extension, and with the child argv that extension runs, failing if pi rejects any of it or cannot load the extension.";
  }
  ''
    export HOME="$TMPDIR"
    node ${./pi-cli-contract.mjs} ${runtime}/packages/runner/src/pi.ts ${forge-runner}/${forge-runner.subagentExtension} ${lib.getExe pi-coding-agent}
    echo "pi-coding-agent ${pi-coding-agent.version} accepts the runner's pi adapter argv and loads its subagent extension" > $out
  ''
