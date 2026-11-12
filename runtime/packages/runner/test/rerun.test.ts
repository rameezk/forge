import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RerunChannel } from '../src/rerun.ts';

const openChannel = (): Promise<RerunChannel> =>
  RerunChannel.open(mkdtempSync(join(tmpdir(), 'forge-rerun-')), {
    github: 'rameezk/forge',
    fetch: async () => new Response('{}', { status: 404 }),
    token: async () => 'token',
    pullRequest: async () => 1,
  });

const send = (path: string, text: string, end: boolean): Promise<string> =>
  new Promise((resolve) => {
    let received = '';
    const socket = connect(path, () => socket.write(text, () => end && socket.destroy()));
    socket.on('data', (chunk) => {
      received += String(chunk);
    });
    socket.on('close', () => resolve(received));
    socket.on('error', () => undefined);
  });

test('given a workload that drops its connection halfway through a request, when the runner serves the next ask, then the runner is still up and answers it', async (t) => {
  const channel = await openChannel();
  t.after(() => channel.close());
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', record);
  t.after(() => process.off('unhandledRejection', record));

  await send(channel.path, 'POST /rerun HTTP/1.1\r\nhost: forge\r\ncontent-length: 100\r\n\r\nab', true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const answer = await send(
    channel.path,
    'POST /rerun HTTP/1.1\r\nhost: forge\r\nconnection: close\r\ncontent-length: 10\r\n\r\n{"run":12}',
    false,
  );

  assert.deepEqual(unhandled, []);
  assert.match(answer, /GitHub answered 404 for pull request #1/);
});

test('given GitHub that never answers, when a workload asks, then the ask is answered as not re-run and the next ask is not stuck behind it', async (t) => {
  const channel = await RerunChannel.open(mkdtempSync(join(tmpdir(), 'forge-rerun-')), {
    github: 'rameezk/forge',
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      }),
    token: async () => 'token',
    pullRequest: async () => 1,
    timeoutMs: 50,
  });
  t.after(() => channel.close());

  const ask = 'POST /rerun HTTP/1.1\r\nhost: forge\r\nconnection: close\r\ncontent-length: 10\r\n\r\n{"run":12}';
  const first = await send(channel.path, ask, false);
  const second = await send(channel.path, ask, false);

  for (const answer of [first, second]) assert.match(answer, /"rerun":false.*timed out/);
});

test('given a token mint that never answers, when a workload asks twice, then each ask is answered as not re-run', async (t) => {
  const channel = await RerunChannel.open(mkdtempSync(join(tmpdir(), 'forge-rerun-')), {
    github: 'rameezk/forge',
    fetch: async () => new Response('{}'),
    token: () => new Promise<string>(() => undefined),
    pullRequest: async () => 1,
    timeoutMs: 50,
  });
  t.after(() => channel.close());

  const ask = 'POST /rerun HTTP/1.1\r\nhost: forge\r\nconnection: close\r\ncontent-length: 10\r\n\r\n{"run":12}';

  for (const answer of [await send(channel.path, ask, false), await send(channel.path, ask, false)]) {
    assert.match(answer, /"rerun":false.*took too long/);
  }
});

test('given a re-run that GitHub accepts after the runner stopped waiting, when a workload asks three times, then at most two re-runs are sent', async (t) => {
  const posts: string[] = [];
  const channel = await RerunChannel.open(mkdtempSync(join(tmpdir(), 'forge-rerun-')), {
    github: 'rameezk/forge',
    fetch: (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'POST') {
        posts.push(path);
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path.includes('/pulls/')
              ? { head: { sha: 'a', ref: 'b' } }
              : { head_sha: 'a', head_branch: 'b', status: 'completed', conclusion: 'failure' },
          ),
        ),
      );
    },
    token: async () => 'token',
    pullRequest: async () => 1,
    timeoutMs: 50,
  });
  t.after(() => channel.close());

  const ask = 'POST /rerun HTTP/1.1\r\nhost: forge\r\nconnection: close\r\ncontent-length: 10\r\n\r\n{"run":12}';
  const answers = [];
  for (let attempt = 0; attempt < 3; attempt += 1) answers.push(await send(channel.path, ask, false));

  assert.equal(posts.length, 2);
  assert.match(answers[2] ?? '', /limit of 2/);
});

test('given a pull request lookup that answers after the runner stopped waiting, when it finally resolves, then no re-run is sent', async (t) => {
  const posts: string[] = [];
  let release: (number: number) => void = () => undefined;
  const channel = await RerunChannel.open(mkdtempSync(join(tmpdir(), 'forge-rerun-')), {
    github: 'rameezk/forge',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'POST') posts.push(path);
      return new Response(
        JSON.stringify(
          path.includes('/pulls/')
            ? { head: { sha: 'a', ref: 'b' } }
            : { head_sha: 'a', head_branch: 'b', status: 'completed', conclusion: 'failure' },
        ),
      );
    },
    token: async () => 'token',
    pullRequest: () => new Promise<number>((resolve) => (release = resolve)),
    timeoutMs: 50,
  });
  t.after(() => channel.close());

  const ask = 'POST /rerun HTTP/1.1\r\nhost: forge\r\nconnection: close\r\ncontent-length: 10\r\n\r\n{"run":12}';
  const answer = await send(channel.path, ask, false);
  release(1);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.match(answer, /took too long/);
  assert.deepEqual(posts, []);
});

const NOW = Date.parse('2026-11-12T12:00:00Z');

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

interface StalledScenario {
  createdMinutesAgo: number;
  jobs?: number;
  head?: { sha: string; ref: string };
  runBranch?: string;
  completesAfterCancel?: boolean;
  rerunsBefore?: number;
}

const openStalledChannel = async (
  scenario: StalledScenario,
): Promise<{ channel: RerunChannel; calls: string[] }> => {
  const calls: string[] = [];
  let cancelled = false;
  const channel = await RerunChannel.open(mkdtempSync(join(tmpdir(), 'forge-rerun-')), {
    github: 'rameezk/forge',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname.replace('/repos/rameezk/forge', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (path.startsWith('/pulls/')) {
        return new Response(JSON.stringify({ head: scenario.head ?? { sha: 'a', ref: 'b' } }));
      }
      if (path.endsWith('/jobs')) {
        const total = scenario.jobs ?? 0;
        return new Response(JSON.stringify({ total_count: total, jobs: Array.from({ length: total }, () => ({})) }));
      }
      if (path.endsWith('/force-cancel')) cancelled = true;
      if (method === 'POST') return new Response('{}', { status: path.endsWith('/rerun') ? 201 : 202 });
      const done = cancelled && scenario.completesAfterCancel !== false;
      return new Response(
        JSON.stringify({
          head_sha: 'a',
          head_branch: scenario.runBranch ?? 'b',
          status: done ? 'completed' : 'queued',
          conclusion: done ? 'cancelled' : null,
          created_at: minutesAgo(scenario.createdMinutesAgo),
        }),
      );
    },
    token: async () => 'token',
    pullRequest: async () => 1,
    timeoutMs: 100,
    pollMs: 5,
    now: () => NOW,
  });
  const asks = scenario.rerunsBefore ?? 0;
  for (let ask = 0; ask < asks; ask += 1) {
    await send(channel.path, askFor(12), false);
  }
  calls.length = 0;
  return { channel, calls };
};

const askFor = (run: number): string => {
  const body = JSON.stringify({ run });
  return `POST /rerun HTTP/1.1\r\nhost: forge\r\nconnection: close\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
};

const mutations = (calls: string[]): string[] => calls.filter((call) => call.startsWith('POST'));

test('given a run on the head queued with no jobs for 16 minutes, when a workload asks, then the runner force-cancels it, waits for it to complete, re-runs it and answers that it did', async (t) => {
  const { channel, calls } = await openStalledChannel({ createdMinutesAgo: 16 });
  t.after(() => channel.close());

  const answer = await send(channel.path, askFor(12), false);

  assert.match(answer, /"rerun":true/);
  assert.deepEqual(mutations(calls), ['POST /actions/runs/12/force-cancel', 'POST /actions/runs/12/rerun']);
});

test('given a run on the head queued with no jobs for 5 minutes, when a workload asks, then the runner refuses it and changes nothing on GitHub', async (t) => {
  const { channel, calls } = await openStalledChannel({ createdMinutesAgo: 5 });
  t.after(() => channel.close());

  const answer = await send(channel.path, askFor(12), false);

  assert.match(answer, /"rerun":false.*refused/);
  assert.deepEqual(mutations(calls), []);
});

test('given a run on the head queued for 20 minutes with jobs, when a workload asks, then the runner refuses it', async (t) => {
  const { channel, calls } = await openStalledChannel({ createdMinutesAgo: 20, jobs: 1 });
  t.after(() => channel.close());

  const answer = await send(channel.path, askFor(12), false);

  assert.match(answer, /"rerun":false.*refused/);
  assert.deepEqual(mutations(calls), []);
});

test('given a stalled run on another branch or commit than the pull request head, when a workload asks, then the runner refuses it as not on the head', async (t) => {
  for (const scenario of [{ runBranch: 'other' }, { head: { sha: 'z', ref: 'b' } }]) {
    const { channel, calls } = await openStalledChannel({ createdMinutesAgo: 16, ...scenario });
    t.after(() => channel.close());

    const answer = await send(channel.path, askFor(12), false);

    assert.match(answer, /"rerun":false.*not on the head/);
    assert.deepEqual(mutations(calls), []);
  }
});

test('given a workload that has had two runs re-run, when it asks about a stalled run, then the runner refuses it as over the limit', async (t) => {
  const { channel, calls } = await openStalledChannel({ createdMinutesAgo: 16, rerunsBefore: 2 });
  t.after(() => channel.close());

  const answer = await send(channel.path, askFor(12), false);

  assert.match(answer, /"rerun":false.*limit of 2/);
  assert.deepEqual(mutations(calls), []);
});

test('given a stalled run that GitHub still reports as not completed after force-cancel, when a workload asks twice, then each ask is answered as not re-run and nothing is re-run', async (t) => {
  const { channel, calls } = await openStalledChannel({ createdMinutesAgo: 16, completesAfterCancel: false });
  t.after(() => channel.close());

  const first = await send(channel.path, askFor(12), false);
  const second = await send(channel.path, askFor(12), false);

  for (const answer of [first, second]) assert.match(answer, /"rerun":false.*took too long/);
  assert.equal(mutations(calls).filter((call) => call.endsWith('/rerun')).length, 0);
});
