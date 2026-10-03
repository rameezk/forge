import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessEvent, MessageEvent } from '@forge/shared';
import { SUBAGENT_TOOL } from '@forge/pi-subagent';
import { PiHarness } from '../src/index.ts';
import { loadPiSkills, resolveCheckout } from '../src/checkout.ts';
import type { HarnessInvocation } from '../src/harness.ts';
import {
  alphaChild,
  bash,
  delegating,
  mentions,
  serve,
  sse,
  textReply,
  toolCallReply,
  usage,
  type Respond,
  type Usage,
} from './fixtures/fake-provider.ts';

const EXTENSION = join(import.meta.dirname, '..', '..', 'pi-subagent', 'src');

const piPackage = process.env.FORGE_PI_PACKAGE;
const skip =
  piPackage === undefined
    ? 'FORGE_PI_PACKAGE is not set to the locked pi package'
    : false;

interface Served {
  id: string;
  usage: Usage;
}

interface Requested {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string } }[];
}

const recording = (
  respond: Respond,
  served: Served[],
  requested: Requested[],
): Respond => (call, res, request) => {
  requested.push(request as Requested);
  const write = res.write.bind(res) as (chunk: string) => boolean;
  res.write = ((chunk: string) => {
    const frame = /^data: (\{.*\})\n\n$/.exec(chunk)?.[1];
    if (frame !== undefined) {
      const parsed = JSON.parse(frame) as { id: string; usage?: Usage };
      if (parsed.usage !== undefined) {
        served.push({ id: parsed.id, usage: parsed.usage });
      }
    }
    return write(chunk);
  }) as ServerResponse['write'];
  respond(call, res, request);
};

const replies: Respond = (call, res) =>
  sse(
    res,
    call === 1
      ? toolCallReply(
          'gen-real-1',
          'Let me look.',
          [bash('echo forge')],
          usage(1200, 0, 40, 1000),
          'I should run the command.',
        )
      : textReply(
          'gen-real-2',
          'The command printed forge.',
          usage(1300, 1000, 25, 200),
        ),
  );

const unreadCacheDetail =
  (respond: Respond): Respond =>
  (call, res, request) => {
    const write = res.write.bind(res) as (chunk: string) => boolean;
    res.write = ((chunk: string) =>
      write(
        chunk.replace('"prompt_tokens_details"', '"unread_tokens_details"'),
      )) as ServerResponse['write'];
    respond(call, res, request);
  };

const passthrough = `#!/bin/sh
while [ "$1" != -- ]; do
  if [ "$1" = --chdir ]; then dir=$2; fi
  shift
done
shift
cd "$dir" || exit 1
"$@"
code=$?
printf '{"exit-code": %s}\\n' "$code" >&3
exit $code
`;

type Workload = (
  workDir: string,
) => Promise<Pick<HarnessInvocation, 'prompt' | 'checkout'>>;

const echoForge: Workload = () =>
  Promise.resolve({ prompt: 'Run echo forge, then say what it printed.' });

interface RealPiRun {
  events: HarnessEvent[];
  agentDir: string[];
}

interface RealPiOptions {
  served?: Served[];
  requested?: Requested[];
  onTheWire?: (respond: Respond) => Respond;
  workload?: Workload;
}

const runRealPi = async (
  respond: Respond,
  {
    served = [],
    requested = [],
    onTheWire = (inner) => inner,
    workload = echoForge,
  }: RealPiOptions = {},
): Promise<RealPiRun> => {
  const server = await serve(onTheWire(recording(respond, served, requested)));
  const { port } = server.address() as AddressInfo;
  const root = mkdtempSync(join(tmpdir(), 'forge-real-pi-'));
  const agentDir = join(root, 'agent');
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  for (const dir of [agentDir, home, workDir]) {
    mkdirSync(dir);
  }
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/v1` } },
    }),
  );
  chmodSync(agentDir, 0o555);
  const bwrap = join(root, 'passthrough-bwrap');
  writeFileSync(bwrap, passthrough);
  chmodSync(bwrap, 0o755);
  const harness = new PiHarness({
    command: join(piPackage as string, '..', '..', '..', 'bin', 'pi'),
    extension: EXTENSION,
    agentDir,
    sandbox: { bwrap, home },
    system: { PATH: process.env.PATH ?? '' },
    env: { OPENROUTER_API_KEY: 'sk-fake' },
  });
  const events: HarnessEvent[] = [];
  try {
    for await (const event of harness.run({
      model: 'z-ai/glm-5',
      workDir,
      reasoningEffort: 'high',
      ...(await workload(workDir)),
    })) {
      events.push(event);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  return { events, agentDir: readdirSync(agentDir) };
};

const assistantMessages = (events: HarnessEvent[]): MessageEvent[] =>
  events.filter(
    (event): event is MessageEvent =>
      event.type === 'message' && event.role === 'assistant',
  );

const assertParsedAsServed = (
  events: HarnessEvent[],
  served: Served[],
): void => {
  const expected = served.map(({ id, usage: total }) => {
    const details = total.prompt_tokens_details;
    return {
      generationId: id,
      usage: {
        inputTokens:
          total.prompt_tokens - details.cached_tokens - details.cache_write_tokens,
        outputTokens: total.completion_tokens,
        cacheReadTokens: details.cached_tokens,
        cacheWriteTokens: details.cache_write_tokens,
      },
    };
  });
  const parsed = assistantMessages(events).map(({ generationId, usage: u }) => ({
    generationId,
    usage: u,
  }));
  assert.deepEqual(parsed, expected);
};

test(
  'given the locked pi with the forge extension and the fake provider, when a workload runs, then the runner parses the usage of every generation the fake provider returned',
  { skip },
  async () => {
    const served: Served[] = [];
    const requested: Requested[] = [];
    const { events } = await runRealPi(replies, { served, requested });

    assert.ok(
      requested[0]?.tools?.some((tool) => tool.function.name === SUBAGENT_TOOL),
    );
    assert.equal(served.length, 2);
    assertParsedAsServed(events, served);
    const end = events.at(-1);
    assert.equal(end?.type, 'result');
    assert.deepEqual(end, { ...end, status: 'success', error: null });
  },
);

test(
  'given a fake provider whose cache usage the pinned pi does not read, when the locked pi runs, then the check against what the provider returned fails',
  { skip },
  async () => {
    const served: Served[] = [];
    const { events } = await runRealPi(replies, {
      served,
      onTheWire: unreadCacheDetail,
    });

    assert.equal(served.length, 2);
    assert.throws(
      () => assertParsedAsServed(events, served),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        /cacheReadTokens|cacheWriteTokens/.test(error.message),
    );
  },
);

const SYSTEM_PROMPT = 'You are the checkout system prompt for the real pi test.';

const PROJECT_INSTRUCTIONS = 'Follow the checkout project instructions.';

const SKILL_BODY = 'Delegate the work to two sub-agents and summarise them.';

const checkoutFiles: Record<string, string> = {
  '.pi/skills/delegate/SKILL.md': `---\nname: delegate\ndescription: Delegates work to sub-agents.\n---\n\n${SKILL_BODY}\n`,
  '.pi/SYSTEM.md': `${SYSTEM_PROMPT}\n`,
  '.pi/settings.json': JSON.stringify({ defaultThinkingLevel: 'off' }),
  'AGENTS.md': `${PROJECT_INSTRUCTIONS}\n`,
};

const delegateSkill: Workload = async (workDir) => {
  for (const [path, contents] of Object.entries(checkoutFiles)) {
    mkdirSync(dirname(join(workDir, path)), { recursive: true });
    writeFileSync(join(workDir, path), contents);
  }
  return {
    prompt: '/delegate both tasks',
    checkout: resolveCheckout(
      workDir,
      await loadPiSkills(piPackage as string),
    ),
  };
};

const generationsBy = (
  events: HarnessEvent[],
): Record<string, (string | null)[]> => {
  const by: Record<string, (string | null)[]> = {};
  for (const { subagent, generationId } of assistantMessages(events)) {
    (by[subagent ?? 'parent'] ??= []).push(generationId);
  }
  return by;
};

test(
  'given the locked pi on a read-only agent dir and a checkout with skills, a system prompt, project instructions and its own pi settings, when a workload runs a skill command that spawns subagents, then the skill and system prompt reach the provider, each subagent runs and its generations come back scoped to its tool call, and pi writes nothing to its agent dir',
  { skip },
  async () => {
    const requested: Requested[] = [];
    const { events, agentDir } = await runRealPi(
      delegating(alphaChild, 'Both sub-agents reported back.'),
      { requested, workload: delegateSkill },
    );

    const [first] = requested;
    assert.ok(first);
    for (const text of [SYSTEM_PROMPT, PROJECT_INSTRUCTIONS, SKILL_BODY]) {
      assert.ok(mentions(first, text), `the first request lacks: ${text}`);
    }
    assert.deepEqual(generationsBy(events), {
      parent: ['gen-subagents-1', 'gen-subagents-2'],
      call_alpha: ['gen-child-alpha-1', 'gen-child-alpha-2'],
      call_beta: ['gen-child-beta-1'],
    });
    assert.deepEqual(
      events
        .filter((event) => event.type === 'tool_result' && event.subagent === undefined)
        .map((event) => event.type === 'tool_result' && [event.id, event.isError])
        .sort(),
      [
        ['call_alpha', false],
        ['call_beta', false],
      ],
    );
    assert.deepEqual(events.at(-1), {
      ...events.at(-1),
      type: 'result',
      status: 'success',
      error: null,
    });
    assert.deepEqual(agentDir, ['models.json']);
  },
);
