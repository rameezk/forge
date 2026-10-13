{
  lib,
  runCommand,
  nodejs,
  claude-code,
  forge-runner,
}:
let
  runtime = "${forge-runner}/lib/forge-runtime";
in
runCommand "claude-code-cli-contract"
  {
    nativeBuildInputs = [ nodejs ];
    meta.description = "Runs the locked claude with the exact argv and environment the runner's claude-code adapter uses, at every reasoning effort and with none, against a fake Anthropic endpoint from a cwd holding a repository AGENTS.md and an empty config dir, failing if claude rejects any flag, stops emitting stream-json with a system init event, assistant events and a successful result, stops writing the raw API bodies the runner reads each request's token counts from, stops loading the repository's AGENTS.md from a cold config dir, does not append forge's instructions to its system prompt, produces an init event on a warm config dir that differs from a cold one beyond its per-process fields, stops carrying forge's instructions into a subagent's system prompt, lets a subagent spawn one of its own, stops refusing subagents past four at once or lets a checkout's own settings raise that limit or the depth, stops answering an Agent call with the report its subagent handed back, or stops tagging a subagent's assistant, Skill call and Skill result stream lines with the id of the tool call that spawned it.";
  }
  ''
    export HOME="$TMPDIR"
    node ${./claude-code-cli-contract.mjs} ${runtime}/packages/runner/src/claude-code.ts ${lib.getExe claude-code} ${runtime}/packages/runner/test/fixtures
    echo "claude ${claude-code.version} accepts the runner's claude-code adapter argv and environment, emits stream-json and the raw API bodies the runner reads, loads the repository's AGENTS.md from a cold config dir, and starts the same from a warm one" > $out
  ''
