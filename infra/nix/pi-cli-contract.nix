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
    meta.description = "Runs the locked pi-coding-agent with the exact argv the runner's pi adapter uses on each provider, openrouter and anthropic, and a read-only agent dir written the way the runner writes it, at every reasoning effort and with none, with and without a checkout's skill paths, appended project instructions, system prompt files and a /skill: prompt, loading the runner's subagent and request record extensions and, with no reasoning effort, its model default reasoning extension, and with the child argv that extension runs, from a cwd holding its own pi settings, extensions and skills, failing if pi rejects any of it, does not reach its credential check for the provider, warns about a thinking level, writes its agent dir, cannot load the extension, or loads resources planted where a run could write them, and checking that a model missing from pi's catalog warns as not found without the agent dir's models.json, and with it gives no warning and lists the declared context window, and that the runner reads an anthropic model's list price from pi's catalog.";
  }
  ''
    export HOME="$TMPDIR"
    node ${./pi-cli-contract.mjs} ${runtime}/packages/runner/src/pi.ts ${forge-runner}/${forge-runner.subagentExtension} ${forge-runner}/${forge-runner.modelDefaultReasoningExtension} ${forge-runner}/${forge-runner.requestRecordExtension} ${lib.getExe pi-coding-agent} ${forge-runner.piPackage}
    echo "pi-coding-agent ${pi-coding-agent.version} accepts the runner's pi adapter argv and read-only agent dir, reads the worker's model from the agent dir's models.json, loads its subagent, request record and model default reasoning extensions, and loads nothing planted where a run could write" > $out
  ''
