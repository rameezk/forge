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
    meta.description = "Runs the locked claude with the exact argv and environment the runner's claude-code adapter uses, against a fake Anthropic endpoint, failing if the CLI rejects a flag, stops emitting the stream-json the runner reads, stops writing the raw API bodies it takes token counts from, stops loading the repository's AGENTS.md or appending forge's instructions, still sends the model an instruction to add commit or pull request attribution, or stops honouring forge's subagent limits, subagent reports and tool call attribution.";
  }
  ''
    export HOME="$TMPDIR"
    node ${./claude-code-cli-contract.mjs} ${runtime}/packages/runner/src/claude-code.ts ${lib.getExe claude-code} ${runtime}/packages/runner/test/fixtures
    echo "claude ${claude-code.version} accepts the runner's claude-code adapter argv and environment, emits stream-json and the raw API bodies the runner reads, loads the repository's AGENTS.md from a cold config dir, and starts the same from a warm one" > $out
  ''
