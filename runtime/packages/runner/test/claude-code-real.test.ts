import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessEvent, MessageEvent, SkillLoadEvent } from '@forge/shared';
import { ClaudeCodeHarness } from '../src/index.ts';
import { PASSTHROUGH_BWRAP, skillCheckout } from './helpers.ts';
import {
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
  workDir: string;
  home: string;
  runsDir: string;
}

interface RealClaudeOptions {
  files?: Record<string, string>;
  homeFiles?: Record<string, string>;
  maxCostUsd?: number | null;
  respond?: RespondMessages;
  prompt?: string;
  args?: string[];
}

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
}: RealClaudeOptions = {}): Promise<RealClaudeRun> => {
  const requests: MessagesRequest[] = [];
  const server = await serveMessages(respond, requests);
  const { port } = server.address() as AddressInfo;
  const root = mkdtempSync(join(tmpdir(), 'forge-real-claude-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const runsDir = join(root, 'runs');
  for (const dir of [home, workDir, runsDir]) mkdirSync(dir);
  writeAll(workDir, files);
  writeAll(home, homeFiles);
  const bwrap = join(root, 'passthrough-bwrap');
  writeFileSync(bwrap, PASSTHROUGH_BWRAP);
  chmodSync(bwrap, 0o755);
  const harness = new ClaudeCodeHarness({
    command: claudeCommand as string,
    runsDir,
    maxCostUsd,
    sandbox: { bwrap, home },
    system: { PATH: process.env.PATH ?? '' },
    extraArgs: args,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
  });
  const events: HarnessEvent[] = [];
  const loads: SkillLoadEvent[] = [];
  const rawEvents: Record<string, unknown>[] = [];
  try {
    for await (const event of harness
      .open({ runId: 'run-1', model: 'claude-opus-4-5', listedModel: null })
      .run(
        {
          model: 'claude-opus-4-5',
          workDir,
          prompt,
          checkout: skillCheckout(workDir, files),
        },
        {
          stop: new AbortController().signal,
          rawEvent: (event) => rawEvents.push(event as Record<string, unknown>),
          requestRecord: () => undefined,
        },
      )) {
      if (event.type === 'skill_load') loads.push(event);
      else events.push(event);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  return { events, loads, rawEvents, requests, workDir, home, runsDir };
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

const PROJECT_HOOK = {
  hooks: {
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'touch project-hook-ran' }] },
    ],
  },
};

const skillFile = (name: string): string =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo the ${name} thing.\n`;

test(
  'given a checkout with its own instructions, skill and hook and a host home with its own, when a workload runs, then claude sees the checkout and nothing of the host, and forge\'s instructions are appended to claude\'s own system prompt',
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
    assert.ok(init.skills.includes('project-skill'));
    assert.equal(init.skills.includes('host-skill'), false);
    assert.ok(existsSync(join(workDir, 'project-hook-ran')));
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
    const { events } = await runRealClaude({
      respond: scenario.respond,
      args: scenario.args ?? [],
    });

    const compactions = events.filter((event) => event.type === 'compaction');
    assert.equal(compactions.length, 1);
    const [compaction] = compactions;
    assert.equal(compaction?.reason, 'auto');
    assert.ok((compaction?.tokensBefore ?? 0) >= 190_000);
    assert.equal(compaction?.generationId, 'req_forge_compaction_summary');
    assert.deepEqual(compaction?.usage, {
      inputTokens: 6000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
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
    assert.equal(compactions[0]?.generationId, 'req_forge_subagent_compaction_summary');
  },
);
