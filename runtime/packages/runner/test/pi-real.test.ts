import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import type { CacheWarmEvent, CompactionEvent, HarnessEvent, MessageEvent } from '@forge/shared';
import { SUBAGENT_TOOL } from '@forge/pi-subagent';
import { PiHarness } from '../src/index.ts';
import { loadPiSkills, resolveCheckout } from '../src/checkout.ts';
import { withEffort, type HarnessInvocation } from '../src/harness.ts';
import {
  alphaChild,
  bash,
  delegating,
  mentions,
  serve,
  sse,
  SUBAGENTS_PROMPT,
  textReply,
  toolCallReply,
  usage,
  compacting,
  warming,
  WARMING_MODEL_OVERRIDES,
  COMPACTION_SETTINGS,
  EARLIER_MESSAGE,
  type Respond,
  type Usage,
} from './fixtures/fake-provider.ts';
import {
  FORCE_CACHE_WARM_EXTENSION,
  PI_EXTENSIONS,
  PASSTHROUGH_BWRAP,
} from './helpers.ts';

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
  reasoning?: { effort?: string };
}

const recording = (
  respond: Respond,
  served: Served[],
  requested: Requested[],
): Respond => (call, res, request, headers) => {
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
  respond(call, res, request, headers);
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
  (call, res, request, headers) => {
    const write = res.write.bind(res) as (chunk: string) => boolean;
    res.write = ((chunk: string) =>
      write(
        chunk.replace('"prompt_tokens_details"', '"unread_tokens_details"'),
      )) as ServerResponse['write'];
    respond(call, res, request, headers);
  };

type Workload = (
  workDir: string,
) => Promise<Pick<HarnessInvocation, 'prompt' | 'checkout'>>;

const echoForge: Workload = () =>
  Promise.resolve({ prompt: 'Run echo forge, then say what it printed.' });

interface RealPiRun {
  events: HarnessEvent[];
  agentDir: string[];
  rawEvents: unknown[];
  requestRecord: unknown[];
}

interface RealPiOptions {
  served?: Served[];
  requested?: Requested[];
  onTheWire?: (respond: Respond) => Respond;
  workload?: Workload;
  effort?: Pick<HarnessInvocation, 'reasoningEffort'>;
  model?: string;
  settings?: Record<string, unknown>;
  messages?: string[];
  warming?: boolean;
}

const runRealPi = async (
  respond: Respond,
  {
    served = [],
    requested = [],
    onTheWire = (inner) => inner,
    workload = echoForge,
    effort = withEffort('high'),
    model = 'z-ai/glm-5',
    settings,
    messages = [],
    warming: warms = false,
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
      providers: {
        openrouter: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          ...(warms ? { modelOverrides: WARMING_MODEL_OVERRIDES } : {}),
        },
      },
    }),
  );
  if (settings === undefined) {
    chmodSync(agentDir, 0o555);
  } else {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
  }
  const bwrap = join(root, 'passthrough-bwrap');
  writeFileSync(bwrap, PASSTHROUGH_BWRAP);
  chmodSync(bwrap, 0o755);
  const harness = new PiHarness({
    command: join(piPackage as string, '..', '..', '..', 'bin', 'pi'),
    openAgentDir: () => agentDir,
    extensions: PI_EXTENSIONS,
    sandbox: { bwrap, home },
    system: { PATH: process.env.PATH ?? '' },
    env: { OPENROUTER_API_KEY: 'sk-fake' },
    extraArgs: [...(warms ? ['-e', FORCE_CACHE_WARM_EXTENSION] : []), ...messages],
  });
  const events: HarnessEvent[] = [];
  const rawEvents: unknown[] = [];
  const requestRecord: unknown[] = [];
  try {
    for await (const event of harness.open({ runId: 'run-1', model, listedModel: null }).run(
      {
        model,
        workDir,
        ...effort,
        ...(await workload(workDir)),
      },
      {
        stop: new AbortController().signal,
        rawEvent: (event) => rawEvents.push(event),
        requestRecord: (line) => requestRecord.push(line),
      },
    )) {
      if (event.type !== 'skill_load') events.push(event);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  return { events, agentDir: readdirSync(agentDir), rawEvents, requestRecord };
};

const assistantMessages = (events: HarnessEvent[]): MessageEvent[] =>
  events.filter(
    (event): event is MessageEvent =>
      event.type === 'message' && event.role === 'assistant',
  );

const servedCall = ({ id, usage: total }: Served) => {
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
};

const assertParsedAsServed = (
  events: HarnessEvent[],
  served: Served[],
): void => {
  const expected = served.map(servedCall);
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
        .flatMap((event) =>
          event.type === 'tool_result' && event.subagent === undefined
            ? [[event.id, event.isError]]
            : [],
        )
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

const delegateTwo: Workload = () =>
  Promise.resolve({ prompt: SUBAGENTS_PROMPT });

const reasoningByAgent = (
  requested: Requested[],
): Record<string, unknown[]> => {
  const by: Record<string, unknown[]> = {};
  for (const request of requested) {
    (by[mentions(request, 'You are a sub-agent') ? 'child' : 'parent'] ??=
      []).push(request.reasoning);
  }
  return by;
};

for (const { given, effort, then, reasoning } of [
  {
    given: 'no reasoning effort',
    effort: withEffort(undefined),
    then: 'no request from the parent or the child has a reasoning field',
    reasoning: undefined,
  },
  {
    given: 'reasoning effort high',
    effort: withEffort('high'),
    then: 'every request from the parent and the child carries reasoning effort high',
    reasoning: { effort: 'high' },
  },
]) {
  test(
    `given a worker with ${given} whose model calls the subagent tool, when its workload runs against the locked pi, then ${then}`,
    { skip },
    async () => {
      const requested: Requested[] = [];
      await runRealPi(
        delegating(alphaChild, 'Both sub-agents reported back.'),
        {
          requested,
          workload: delegateTwo,
          effort,
        },
      );

      assert.deepEqual(reasoningByAgent(requested), {
        parent: [reasoning, reasoning],
        child: [reasoning, reasoning, reasoning],
      });
    },
  );
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

const hashOf = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

interface Reference {
  role?: string;
  hash: string;
}

interface RequestEntry {
  type: 'request';
  subagent?: string;
  body: Record<string, unknown> & {
    system?: Reference;
    tools?: Reference;
    messages: Reference[];
  };
}

interface Definitions {
  systemPrompts: Map<string, unknown>;
  tools: Map<string, unknown>;
}

const definitionsIn = (record: unknown[]): Definitions => {
  const systemPrompts = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  for (const line of record as { type: string; hash: string; value?: unknown; tools?: unknown }[]) {
    if (line.type === 'system_prompt') systemPrompts.set(line.hash, line.value);
    if (line.type === 'tools') tools.set(line.hash, line.tools);
  }
  return { systemPrompts, tools };
};

const recordedRequests = (record: unknown[]): RequestEntry[] =>
  (record as RequestEntry[]).filter((line) => line.type === 'request');

const ofType = (record: unknown[], type: string): unknown[] =>
  (record as { type: string }[]).filter((line) => line.type === type);

test(
  'given the locked pi with the forge extension and the fake provider on a chat completions model, when a workload makes several calls, then each entry references its system message and tools by definitions holding them exactly as sent, and hashes every other message as sent',
  { skip },
  async () => {
    const requested: Requested[] = [];
    const { requestRecord } = await runRealPi(replies, { requested });
    const entries = recordedRequests(requestRecord);
    const { systemPrompts, tools } = definitionsIn(requestRecord);

    assert.equal(requested.length, 2);
    assert.equal(ofType(requestRecord, 'system_prompt').length, 1);
    assert.equal(ofType(requestRecord, 'tools').length, 1);
    assert.deepEqual(
      entries.map(({ body: { messages, tools: toolsRef, ...settings } }) => ({
        ...settings,
        messages: messages.map(({ role, hash }) => systemPrompts.get(hash) ?? { role, hash }),
        tools: tools.get(toolsRef?.hash ?? ''),
      })),
      requested.map(({ messages, ...settings }) => ({
        ...settings,
        messages: messages.map((message) =>
          message.role === 'system' ? message : { role: message.role, hash: hashOf(message) },
        ),
      })),
    );
  },
);

test(
  'given the locked pi and a fake provider, when the context compacts through a split turn whose first summary attempt fails, then the compaction carries exactly the ids and usage the provider served for those three calls, and the request record holds every request',
  { skip },
  async () => {
    const served: Served[] = [];
    const { events, requestRecord } = await runRealPi(
      compacting('gen-live', { split: true, failFirst: true }),
      { served, settings: COMPACTION_SETTINGS, messages: [EARLIER_MESSAGE] },
    );

    const summaries = served.filter(({ id }) => id.includes('-summary-'));
    assert.deepEqual(
      summaries.map(({ id }) => id),
      ['gen-live-summary-failed', 'gen-live-summary-1', 'gen-live-summary-2'],
    );
    const compactions = events.filter(
      (event): event is CompactionEvent => event.type === 'compaction',
    );
    assert.equal(compactions.length, 1);
    assert.deepEqual(compactions[0]?.calls, summaries.map(servedCall));
    assert.equal(
      requestRecord.filter(
        (line) => (line as { type?: unknown }).type === 'request',
      ).length,
      served.length,
    );
  },
);

test(
  'given the locked pi and a fake provider, when pi warms the prompt cache of a workload that stays busy, then its cache warm carries exactly the id and usage the provider served for the warm request',
  { skip },
  async () => {
    const served: Served[] = [];
    const { events } = await runRealPi(warming('gen-live'), { served, warming: true });

    const warms = served.filter(({ id }) => id.includes('-warm-'));
    assert.deepEqual(warms.map(({ id }) => id), ['gen-live-warm-1']);
    assert.deepEqual(
      events
        .filter((event): event is CacheWarmEvent => event.type === 'cache_warm')
        .map(({ generationId, usage: warmed }) => ({ generationId, usage: warmed })),
      warms.map(servedCall),
    );
  },
);
