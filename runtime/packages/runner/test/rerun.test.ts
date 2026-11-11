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
