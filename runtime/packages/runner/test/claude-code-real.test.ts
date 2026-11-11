import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  HarnessEvent,
  MessageEvent,
  RunFingerprint,
  SkillLoadEvent,
} from '@forge/shared';
import { ClaudeCodeHarness } from '../src/index.ts';
import { FingerprintRecorder } from '../src/fingerprint.ts';
import { OWN_CONTEXT_CASES, PASSTHROUGH_BWRAP, skillCheckout, ticketContextOf, writeFakeBroker } from './helpers.ts';
import { standInShell, standInShellCalls } from './fixtures/stand-in-shell.ts';
import { anthropicReply, anthropicSse, anthropicUsage } from './fixtures/fake-provider.ts';
import {
  dispatchContext,
  NARRATION_INSTRUCTION,
  UNATTENDED_INSTRUCTION,
} from '../src/harness.ts';
import {
  CLAUDE_SKILL_FILES,
  CLAUDE_TOKEN,
  claudeScenarios,
  compactionScenario,
  isSubagentRequest,
  manySubagentsScenario,
  RAISED_LIMIT_FILES,
  retryScenario,
  SUBAGENT_LIMIT_REFUSAL,
  serveMessages,
  subagentCompactionScenario,
  subagentsScenario,
  toolNames,
  type MessagesRequest,
  type RespondMessages,
} from './fixtures/fake-anthropic.ts';

const claudeCommand = process.env.FORGE_CLAUDE_CODE;
const skip =
  claudeCommand === undefined
    ? 'FORGE_CLAUDE_CODE is not set to the locked claude'
    : false;

interface RealClaudeRun {
  events: HarnessEvent[];
  loads: SkillLoadEvent[];
  rawEvents: Record<string, unknown>[];
  requests: MessagesRequest[];
  requestRecord: Record<string, unknown>[];
  fingerprint: RunFingerprint | null;
  workDir: string;
  home: string;
  runsDir: string;
  shellCalls: string[];
}

interface RealClaudeOptions {
  files?: Record<string, string>;
  homeFiles?: Record<string, string>;
  maxCostUsd?: number | null;
  respond?: RespondMessages;
  prompt?: string;
  args?: string[];
  untracked?: Record<string, string>;
  requestIdSuffix?: string;
  instruction?: string;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=Forge', '-c', 'user.email=forge@example.com', ...args],
    { cwd, stdio: 'ignore' },
  );
};

const writeAll = (root: string, files: Record<string, string>): void => {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
};

const runRealClaude = async ({
  files = {},
  homeFiles = {},
  maxCostUsd = null,
  respond = claudeScenarios.success!.respond,
  prompt = 'Run echo forge, then say what it printed.',
  args = [],
  untracked,
  requestIdSuffix = '',
  instruction,
}: RealClaudeOptions = {}): Promise<RealClaudeRun> => {
  const requests: MessagesRequest[] = [];
  const server = await serveMessages(respond, requests, requestIdSuffix);
  const { port } = server.address() as AddressInfo;
  const root = mkdtempSync(join(tmpdir(), 'forge-real-claude-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const runsDir = join(root, 'runs');
  for (const dir of [home, workDir, runsDir]) mkdirSync(dir);
  writeAll(workDir, files);
  if (untracked !== undefined) {
    git(workDir, 'init', '-q', '-b', 'main');
    git(workDir, 'add', '-A');
    git(workDir, 'commit', '-q', '--allow-empty', '-m', 'init');
    writeAll(workDir, untracked);
  }
  writeAll(home, homeFiles);
  const bwrap = join(root, 'passthrough-bwrap');
  writeFileSync(bwrap, PASSTHROUGH_BWRAP);
  chmodSync(bwrap, 0o755);
  const harness = new ClaudeCodeHarness({
    command: claudeCommand as string,
    runsDir,
    maxCostUsd,
    sandbox: { bwrap, home },
    tools: { ...writeFakeBroker(root), ...standInShell(root), gitShimDir: join(root, 'no-git-shim') },
    system: { PATH: process.env.PATH ?? '' },
    extraArgs: args,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    commandEnv: {},
  });
  const events: HarnessEvent[] = [];
  const loads: SkillLoadEvent[] = [];
  const rawEvents: Record<string, unknown>[] = [];
  const requestRecord: Record<string, unknown>[] = [];
  let fingerprint: RunFingerprint | null = null;
  try {
    const invocation = {
      model: 'claude-opus-4-5',
      workDir,
      prompt,
      checkout: skillCheckout(workDir, files),
      ...(instruction === undefined ? {} : { instruction }),
    };
    const run = harness.open({ runId: 'run-1', model: 'claude-opus-4-5', listedModel: null });
    const recorder = new FingerprintRecorder({
      worker: { name: 'refiner', harness: 'claude-code', provider: 'anthropic', model: 'claude-opus-4-5', prompt, promptTemplate: 'work the ticket' },
      identity: await run.identity(),
      basis: run.fingerprintBasis(invocation),
      skills: null,
      baseCommit: null,
      forgeGitSha: null,
      record: (recorded) => {
        fingerprint = recorded;
      },
    });
    for await (const event of run.run(invocation, {
      stop: new AbortController().signal,
      rawEvent: (event) => rawEvents.push(event as Record<string, unknown>),
      requestRecord: (line) => {
        recorder.observe(line);
        requestRecord.push(line as Record<string, unknown>);
      },
    })) {
      if (event.type === 'skill_load') loads.push(event);
      else events.push(event);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  const calls = standInShellCalls(root);
  const shellCalls = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((line) => line !== '') : [];
  return { events, loads, rawEvents, requests, requestRecord, fingerprint: fingerprint as RunFingerprint | null, workDir, home, runsDir, shellCalls };
};

const assistantMessages = (events: HarnessEvent[]): MessageEvent[] =>
  events.filter(
    (event): event is MessageEvent =>
      event.type === 'message' && event.role === 'assistant',
  );

test(
  'given the locked claude and the fake Anthropic endpoint, when a workload runs, then the runner parses the request id and four token counts of every request the endpoint served',
  { skip },
  async () => {
    const { events, requests } = await runRealClaude();

    assert.equal(requests.length, 2);
    assert.deepEqual(
      assistantMessages(events).map(({ generationId, usage }) => ({
        generationId,
        usage,
      })),
      [
        {
          generationId: 'req_forge_success_1',
          usage: {
            inputTokens: 200,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 1000,
          },
        },
        {
          generationId: 'req_forge_success_2',
          usage: {
            inputTokens: 300,
            outputTokens: 25,
            cacheReadTokens: 1000,
            cacheWriteTokens: 200,
          },
        },
      ],
    );
    const end = events.at(-1);
    assert.deepEqual(end, { ...end, type: 'result', status: 'success', error: null });
  },
);

test(
  'given the locked claude, when a workload runs, then its request record holds claude\'s system prompt and tool definitions and one request line per request the endpoint served',
  { skip },
  async () => {
    const { requests, requestRecord, fingerprint } = await runRealClaude();

    const lines = (type: string): Record<string, unknown>[] =>
      requestRecord.filter((line) => line.type === type);
    assert.equal(lines('request').length, requests.length);
    assert.ok(lines('system_prompt').length >= 1);
    assert.match(JSON.stringify(lines('system_prompt')), /You are Claude Code/);
    const toolList = lines('tools').flatMap(({ tools }) => tools as { name: string }[]);
    assert.ok(toolList.some(({ name }) => name === 'Bash'));
    assert.ok(fingerprint);
    assert.equal(fingerprint.fingerprint.harness, 'claude-code');
    assert.notEqual(fingerprint.fingerprint.systemPrompt, null);
    assert.notEqual(fingerprint.fingerprint.tools, null);
  },
);

test(
  'given the locked claude and two runs of one worker in different work dirs, with different prompts, ticket and parent spec context, git statuses, times and request ids, when each runs, then both fingerprints hash alike',
  { skip },
  async () => {
    const files = { 'README.md': 'a repo\n' };
    const first = await runRealClaude({
      files,
      untracked: { 'notes.md': 'one\n' },
      prompt: `Run echo forge, then say what it printed.\n\n${dispatchContext(ticketContextOf(113, 'the first ticket'))}`,
      requestIdSuffix: '_one',
    });
    const second = await runRealClaude({
      files,
      untracked: { 'other.md': 'two\n', 'more.md': 'three\n' },
      prompt: `Say hello, then run echo forge.\n\n${dispatchContext(ticketContextOf(214, 'the second ticket'))}`,
      requestIdSuffix: '_two',
    });

    assert.notEqual(first.workDir, second.workDir);
    assert.ok(first.fingerprint);
    assert.ok(second.fingerprint);
    assert.equal(first.fingerprint.fingerprint.systemPrompt, second.fingerprint.fingerprint.systemPrompt);
    assert.equal(first.fingerprint.fingerprint.tools, second.fingerprint.fingerprint.tools);
    assert.equal(first.fingerprint.hash, second.fingerprint.hash);
  },
);

test(
  'given the locked claude and two repos that differ only in a skill, when each runs, then the fingerprints differ in their settings and nothing else',
  { skip },
  async () => {
    const skilled = (body: string): Record<string, string> => ({
      '.claude/skills/project-skill/SKILL.md': skillFile('project-skill', body),
    });
    const first = await runRealClaude({ files: skilled('Do one.') });
    const second = await runRealClaude({ files: skilled('Do two.') });

    assert.ok(first.fingerprint);
    assert.ok(second.fingerprint);
    assert.notEqual(first.fingerprint.hash, second.fingerprint.hash);
    const { settings: before, ...rest } = first.fingerprint.fingerprint;
    const { settings: after, ...others } = second.fingerprint.fingerprint;
    assert.notEqual(before, after);
    assert.notEqual(before, undefined);
    assert.deepEqual(rest, others);
  },
);

test(
  'given the locked claude and two repos that differ only in their own Claude Code settings and hooks, when each runs, then the fingerprints are the same, because forge loads neither',
  { skip },
  async () => {
    const hooked = (command: string): Record<string, string> => ({
      '.claude/settings.json': JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] },
      }),
      '.claude/hooks/check.sh': command,
    });
    const first = await runRealClaude({ files: hooked('true') });
    const second = await runRealClaude({ files: hooked('false') });

    assert.ok(first.fingerprint);
    assert.ok(second.fingerprint);
    assert.equal(first.fingerprint.hash, second.fingerprint.hash);
  },
);

test(
  'given the locked claude and two repos that differ only in AGENTS.md, when each runs, then the fingerprints differ in their instructions and nothing else',
  { skip },
  async () => {
    const first = await runRealClaude({ files: { 'AGENTS.md': 'Prefer tabs.\n' } });
    const second = await runRealClaude({ files: { 'AGENTS.md': 'Prefer spaces.\n' } });

    assert.ok(first.fingerprint);
    assert.ok(second.fingerprint);
    assert.notEqual(first.fingerprint.hash, second.fingerprint.hash);
    const { instructions: before, ...rest } = first.fingerprint.fingerprint;
    const { instructions: after, ...others } = second.fingerprint.fingerprint;
    assert.equal(typeof before, 'string');
    assert.equal(typeof after, 'string');
    assert.notEqual(before, after);
    assert.deepEqual(rest, others);
  },
);

test(
  'given the locked claude and a repo with no AGENTS.md or CLAUDE.md, when it runs, then the fingerprint records that it has no instructions',
  { skip },
  async () => {
    const { fingerprint } = await runRealClaude({ files: { 'README.md': 'a repo\n' } });

    assert.ok(fingerprint);
    assert.equal(fingerprint.fingerprint.instructions, null);
  },
);

const PROJECT_HOOK = {
  hooks: {
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'touch project-hook-ran' }] },
    ],
  },
};

const skillFile = (name: string, body = `Do the ${name} thing.`): string =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}\n`;

test(
  'given a checkout with its own instructions, skill and hook and a host home with its own, when a workload runs, then claude sees the checkout\'s instructions and skill, runs neither its hook nor the host\'s, and forge\'s instructions are appended to claude\'s own system prompt',
  { skip },
  async () => {
    const hostMarker = (home: string): string => join(home, 'host-hook-ran');
    const root = mkdtempSync(join(tmpdir(), 'forge-host-marker-'));
    const { rawEvents, requests, workDir, runsDir } = await runRealClaude({
      files: {
        'AGENTS.md': 'The checkout instruction marker is pelican-instruction.\n',
        'CLAUDE.md': 'The checkout claude marker is heron-instruction.\n',
        '.claude/skills/project-skill/SKILL.md': skillFile('project-skill'),
        '.claude/settings.json': JSON.stringify(PROJECT_HOOK),
      },
      homeFiles: {
        '.claude/CLAUDE.md': 'The host instruction marker is vulture-instruction.\n',
        '.claude/skills/host-skill/SKILL.md': skillFile('host-skill'),
        '.claude/settings.json': JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { type: 'command', command: `touch ${hostMarker(root)}` },
                ],
              },
            ],
          },
        }),
      },
    });

    const init = rawEvents.find(
      (event) => event.type === 'system' && event.subtype === 'init',
    ) as { skills: string[] } | undefined;
    assert.ok(init);
    assert.ok(init.skills.includes('repository:project-skill'));
    assert.equal(init.skills.includes('host-skill'), false);
    assert.equal(existsSync(join(workDir, 'project-hook-ran')), false);
    assert.equal(existsSync(hostMarker(root)), false);
    const sent = JSON.stringify(requests[0]);
    assert.match(sent, /heron-instruction/);
    assert.doesNotMatch(sent, /vulture-instruction/);
    assert.ok(sent.includes(UNATTENDED_INSTRUCTION.slice(0, 40)));
    assert.ok(sent.includes(NARRATION_INSTRUCTION.slice(0, 40)));
    assert.match(sent, /Claude Code/);
    assert.equal(existsSync(join(runsDir, 'run-1')), false);
  },
);

test(
  'given the locked claude and a run that spawns two subagents, when a workload runs, then every subagent request carries forge\'s instructions, a subagent cannot spawn one of its own, and the messages and skill loads of each carry the id of the call that spawned it',
  { skip },
  async () => {
    const { events, loads, requests } = await runRealClaude({
      files: CLAUDE_SKILL_FILES,
      prompt: '/first-skill start the work',
      respond: subagentsScenario().respond,
    });

    const children = requests.filter(isSubagentRequest);
    assert.equal(children.length, 3);
    for (const request of children) {
      const sent = JSON.stringify(request.system);
      assert.ok(sent.includes(UNATTENDED_INSTRUCTION.slice(0, 40)));
      assert.ok(sent.includes(NARRATION_INSTRUCTION.slice(0, 40)));
      assert.equal(toolNames(request).includes('Agent'), false);
    }
    const parents = requests.filter((request) => !isSubagentRequest(request));
    assert.ok(parents.every((request) => toolNames(request).includes('Agent')));
    const scopes = assistantMessages(events).map(({ subagent }) => subagent ?? null);
    assert.deepEqual(
      [...new Set(scopes)].sort((a, b) => String(a).localeCompare(String(b))),
      [null, 'toolu_alpha', 'toolu_beta'],
    );
    assert.deepEqual(
      loads.map(({ skill, source, subagent }) => [skill, source, subagent]),
      [
        ['first-skill', 'prompt', null],
        ['other-skill', 'read', 'toolu_alpha'],
        ['other-skill', 'read', 'toolu_alpha'],
      ],
    );
    assert.deepEqual(loads.at(-1)?.coverage?.coveredLines, loads.at(-1)?.coverage?.totalLines);
  },
);

test(
  'given the locked claude and a checkout whose own settings and local settings raise the subagent limits, when a run asks for six subagents at once, then only four start, the other two calls are refused and no subagent can spawn one',
  { skip },
  async () => {
    const { events, requests } = await runRealClaude({
      files: RAISED_LIMIT_FILES,
      respond: manySubagentsScenario(6).respond,
    });

    const refused = events.filter(
      (event) =>
        event.type === 'tool_result' &&
        event.subagent === undefined &&
        event.text.includes(SUBAGENT_LIMIT_REFUSAL),
    );
    assert.equal(refused.length, 2);
    const started = new Set(
      assistantMessages(events).flatMap(({ subagent }) => (subagent === undefined ? [] : [subagent])),
    );
    assert.equal(started.size, 4);
    assert.ok(!events.some((event) => event.type === 'tool_result' && event.text.includes('Async agent launched')));
    const children = requests.filter(isSubagentRequest);
    assert.ok(children.length > 0);
    assert.ok(children.every((request) => !toolNames(request).includes('Agent')));
  },
);

test(
  'given the locked claude and an endpoint that answers its first request with an overload, when a workload runs, then the failed attempt is a retry event with its attempt, attempts allowed and error before the recovered response, and only the recovered request is a generation',
  { skip },
  async () => {
    const { events, requests } = await runRealClaude({ respond: retryScenario().respond });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      events.filter((event) => event.type !== 'result').map((event) => event.type),
      ['retry', 'message'],
    );
    const [retry] = events;
    assert.equal(retry?.type, 'retry');
    if (retry?.type === 'retry') {
      assert.equal(retry.attempt, 1);
      assert.equal(typeof retry.maxAttempts, 'number');
      assert.equal(typeof retry.delayMs, 'number');
      assert.equal(retry.error, 'overloaded (HTTP 529)');
    }
    assert.deepEqual(
      assistantMessages(events).map(({ generationId }) => generationId),
      ['req_forge_retry_1'],
    );
  },
);

test(
  'given the locked claude compacting its context at a window of 100k tokens, when a workload runs, then the compaction is an event with its trigger and tokens before and a generation with the summarizing request\'s id and four token counts',
  { skip },
  async () => {
    const scenario = compactionScenario();
    const { events, requests, requestRecord } = await runRealClaude({
      respond: scenario.respond,
      args: scenario.args ?? [],
    });

    assert.equal(
      requestRecord.filter((line) => line.type === 'request').length,
      requests.length,
    );
    const compactions = events.filter((event) => event.type === 'compaction');
    assert.equal(compactions.length, 1);
    const [compaction] = compactions;
    assert.equal(compaction?.reason, 'auto');
    assert.ok((compaction?.tokensBefore ?? 0) >= 190_000);
    assert.deepEqual(compaction?.calls, [
      {
        generationId: 'req_forge_compaction_summary',
        usage: {
          inputTokens: 6000,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ]);
  },
);

test(
  'given the locked claude and a subagent that compacts its context, when a workload runs, then the compaction and its generation carry the id of the call that spawned that subagent',
  { skip },
  async () => {
    const scenario = subagentCompactionScenario();
    const { events } = await runRealClaude({
      respond: scenario.respond,
      args: scenario.args ?? [],
      prompt: scenario.prompt ?? '',
    });

    const compactions = events.filter((event) => event.type === 'compaction');
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0]?.subagent, 'toolu_alpha');
    assert.deepEqual(
      compactions[0]?.calls?.map(({ generationId }) => generationId),
      ['req_forge_subagent_compaction_summary'],
    );
  },
);

const firstUserMessageOf = ({ messages }: MessagesRequest): string =>
  JSON.stringify(messages.find(({ role }) => role === 'user'));

test(
  'given the locked claude and a dispatch with ticket and parent spec context that spawns subagents, when it runs, then the context is in the first user message, neither the main agent\'s nor a subagent\'s system prompt contains it, and both still carry forge\'s unattended and narration instructions',
  { skip },
  async () => {
    const { requests } = await runRealClaude({
      files: CLAUDE_SKILL_FILES,
      prompt: `/first-skill start the work\n\n${dispatchContext(ticketContextOf(687, 'the context ticket'))}`,
      respond: subagentsScenario().respond,
    });

    const children = requests.filter(isSubagentRequest);
    const parents = requests.filter((request) => !isSubagentRequest(request));
    assert.ok(children.length > 0);
    assert.ok(parents.length > 0);
    for (const request of requests) {
      const system = JSON.stringify(request.system);
      assert.doesNotMatch(system, /the context ticket|ticket 687|The spec behind/);
      assert.ok(system.includes(UNATTENDED_INSTRUCTION.slice(0, 40)));
      assert.ok(system.includes(NARRATION_INSTRUCTION.slice(0, 40)));
    }
    const first = firstUserMessageOf(parents[0] as MessagesRequest);
    assert.match(first, /Build the context ticket for ticket 687/);
    assert.match(first, /The spec behind the context ticket/);
  },
);

for (const { given, instruction, context, marker } of OWN_CONTEXT_CASES) {
  test(
    `given the locked claude and ${given}, when it runs, then the context is in the first user message and not in the system prompt`,
    { skip },
    async () => {
      const { requests } = await runRealClaude({
        prompt: `Do the work.\n\n${context}`,
        instruction,
      });

      const [first] = requests;
      assert.ok(first);
      assert.match(firstUserMessageOf(first), marker);
      assert.doesNotMatch(JSON.stringify(first.system), marker);
      assert.ok(JSON.stringify(first.system).includes(instruction.slice(-40)));
    },
  );
}

const runningCommands =
  (commands: string[]): RespondMessages =>
  (_call, res, request) => {
    const answered = request.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part: { type?: string }) => part.type === 'tool_result').length;
    const usage = anthropicUsage(10, 0, 0, 5);
    const command = commands[answered];
    anthropicSse(
      res,
      command === undefined
        ? anthropicReply(`msg_done_${answered}`, { text: 'done' }, usage)
        : anthropicReply(
            `msg_run_${answered}`,
            { toolUses: [{ id: `toolu_${answered}`, name: 'Bash', input: { command } }] },
            usage,
          ),
    );
  };

const toolResultTexts = (events: HarnessEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'tool_result' ? [event.text] : []));

test(
  'given the locked claude, when its agent runs a command, then claude starts it through the configured shell and its shell prefix and the command runs',
  { skip },
  async () => {
    const { events, shellCalls } = await runRealClaude({
      respond: runningCommands(['echo through-the-shell']),
    });

    assert.ok(toolResultTexts(events).some((text) => text.includes('through-the-shell')));
    assert.ok(shellCalls.includes('shell'), String(shellCalls));
    assert.ok(shellCalls.includes('prefix'), String(shellCalls));
  },
);

test(
  'given the locked claude and a repository with CLAUDE.md, AGENTS.md, a skill, an agent and a command, when a workload starts with the skill\'s bare name, then each is loaded and the skill runs',
  { skip },
  async () => {
    const { rawEvents, requests, loads } = await runRealClaude({
      files: {
        'CLAUDE.md': 'The claude marker is heron-instruction.\n',
        'AGENTS.md': 'The agents marker is pelican-instruction.\n',
        '.claude/skills/project-skill/SKILL.md': skillFile('project-skill', 'Skill body marker ibis-skill.'),
        '.claude/agents/helper.md': '---\nname: helper\ndescription: A helper agent\n---\nYou are the helper.\n',
        '.claude/commands/hello.md': 'Run the hello command.\n',
      },
      prompt: '/project-skill start the work',
    });

    const init = rawEvents.find((event) => event.type === 'system' && event.subtype === 'init') as
      | { agents: string[]; slash_commands: string[] }
      | undefined;
    assert.ok(init);
    assert.ok(init.agents.includes('repository:helper'));
    assert.ok(init.slash_commands.includes('repository:hello'));
    const sent = JSON.stringify(requests[0]);
    for (const marker of ['heron-instruction', 'pelican-instruction', 'ibis-skill']) {
      assert.ok(sent.includes(marker), marker);
    }
    assert.deepEqual(
      loads.map(({ skill, source }) => [skill, source]),
      [['project-skill', 'prompt']],
    );
  },
);

test(
  'given the locked claude and a repository whose own settings set env, a hook and an API key helper and whose .mcp.json starts a server, when its agent runs a command, then none of them takes effect',
  { skip },
  async () => {
    const { events, workDir } = await runRealClaude({
      files: {
        '.claude/settings.json': JSON.stringify({
          env: { PLANTED: 'planted' },
          apiKeyHelper: 'touch helper-ran',
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'touch hook-ran' }] }] },
        }),
        '.mcp.json': JSON.stringify({ mcpServers: { planted: { command: 'touch', args: ['mcp-ran'] } } }),
      },
      respond: runningCommands(['echo "[$PLANTED]"']),
    });

    assert.ok(toolResultTexts(events).some((text) => text.trim() === '[]'), String(toolResultTexts(events)));
    for (const marker of ['helper-ran', 'hook-ran', 'mcp-ran']) {
      assert.equal(existsSync(join(workDir, marker)), false, marker);
    }
  },
);

test(
  'given the locked claude and a prompt over a megabyte long, when the workload runs, then claude receives all of it',
  { skip },
  async () => {
    const prompt = `${'wrangler dev '.repeat(100_000)}the end`;

    const { requests } = await runRealClaude({ prompt });

    assert.ok(prompt.length > 1_000_000);
    assert.ok(JSON.stringify(requests[0]?.messages).includes(prompt));
  },
);
