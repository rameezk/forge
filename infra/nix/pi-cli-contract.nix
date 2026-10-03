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
    meta.description = "Runs the locked pi-coding-agent with the exact argv and read-only agent dir the runner's pi adapter uses, at every reasoning effort and with none, with and without a checkout's skill paths, appended project instructions, system prompt files and a /skill: prompt, loading the runner's subagent extension, and with the child argv that extension runs, from a cwd holding its own pi settings, extensions and skills, failing if pi rejects any of it or warns about a thinking level, writes its agent dir, cannot load the extension, or loads resources planted where a run could write them.";
  }
  ''
    export HOME="$TMPDIR"
    node ${./pi-cli-contract.mjs} ${runtime}/packages/runner/src/pi.ts ${forge-runner}/${forge-runner.subagentExtension} ${lib.getExe pi-coding-agent} ${forge-runner.piAgentDir} ${forge-runner.piPackage}
    echo "pi-coding-agent ${pi-coding-agent.version} accepts the runner's pi adapter argv and read-only agent dir, loads its subagent extension, and loads nothing planted where a run could write" > $out
  ''
