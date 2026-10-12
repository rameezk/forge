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
import type { HarnessEvent, MessageEvent } from '@forge/shared';
import { ClaudeCodeHarness } from '../src/index.ts';
import { PASSTHROUGH_BWRAP } from './helpers.ts';
import {
  NARRATION_INSTRUCTION,
  UNATTENDED_INSTRUCTION,
} from '../src/harness.ts';
import {
  CLAUDE_TOKEN,
  claudeScenarios,
  serveMessages,
  type MessagesRequest,
} from './fixtures/fake-anthropic.ts';

const claudeCommand = process.env.FORGE_CLAUDE_CODE;
const skip =
  claudeCommand === undefined
    ? 'FORGE_CLAUDE_CODE is not set to the locked claude'
    : false;

interface RealClaudeRun {
  events: HarnessEvent[];
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
}: RealClaudeOptions = {}): Promise<RealClaudeRun> => {
  const requests: MessagesRequest[] = [];
  const server = await serveMessages(claudeScenarios.success!.respond, requests);
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
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
  });
  const events: HarnessEvent[] = [];
  const rawEvents: Record<string, unknown>[] = [];
  try {
    for await (const event of harness
      .open({ runId: 'run-1', model: 'claude-opus-4-5', listedModel: null })
      .run(
        {
          provider: 'anthropic',
          model: 'claude-opus-4-5',
          workDir,
          prompt: 'Run echo forge, then say what it printed.',
        },
        {
          stop: new AbortController().signal,
          rawEvent: (event) => rawEvents.push(event as Record<string, unknown>),
          requestRecord: () => undefined,
        },
      )) {
      if (event.type !== 'skill_load') events.push(event);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  return { events, rawEvents, requests, workDir, home, runsDir };
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
