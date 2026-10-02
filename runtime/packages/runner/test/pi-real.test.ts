import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, MessageEvent } from '@forge/shared';
import { SUBAGENT_TOOL } from '@forge/pi-subagent';
import { PiHarness } from '../src/index.ts';
import {
  bash,
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

const runRealPi = async (
  respond: Respond,
  served: Served[],
  requested: Requested[],
  onTheWire: (respond: Respond) => Respond = (inner) => inner,
): Promise<HarnessEvent[]> => {
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
      prompt: 'Run echo forge, then say what it printed.',
      workDir,
      reasoningEffort: 'high',
    })) {
      events.push(event);
    }
  } finally {
    server.close();
    await once(server, 'close');
  }
  return events;
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
    const events = await runRealPi(replies, served, requested);

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
    const events = await runRealPi(replies, served, [], unreadCacheDetail);

    assert.equal(served.length, 2);
    assert.throws(
      () => assertParsedAsServed(events, served),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        /cacheReadTokens|cacheWriteTokens/.test(error.message),
    );
  },
);
