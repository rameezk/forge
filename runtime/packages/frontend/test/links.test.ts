import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const TICKET_URL = 'https://github.com/rameezk/forge/issues/56';

const dashboard = () => {
  const store = Store.open(':memory:');
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      {
        number: 56,
        title: 'Declared repositories show their frontier on the dashboard',
        url: TICKET_URL,
        parent: { number: 54, title: 'Frontier discovery across managed repositories', url: 'https://github.com/rameezk/forge/issues/54' },
        createdAt: '2026-09-28T10:07:58Z',
        forgeReady: true,
        blocked: false,
        forHuman: false,
        blockedBy: [],
      },
    ],
  });
  store.insertRun({
    id: 'run-01',
    worker: 'builder',
    harness: 'pi',
    model: 'z-ai/glm-5',
    reasoningEffort: null,
    startTime: '2026-09-29T09:00:00.000Z',
    endTime: '2026-09-29T09:03:20.000Z',
    status: 'success',
    costStatus: 'billed',
    costUsd: 0.1234,
    costEstimated: false,
    unconfirmedEstimateUsd: 0,
    listPrice: null,
    inputTokens: 4200,
    outputTokens: 850,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptRef: 'run-01.jsonl',
    sessionId: 'sess-abc',
    error: null,
    ticket: { repository: 'forge', number: 56, url: TICKET_URL },
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: null,
    maxCostUsd: null,
    exceededLimit: null,
    counters: null,
  });
  const dispatch = store.startDispatch(
    { repository: 'forge', number: 56, url: TICKET_URL },
    'run-01',
    '2026-09-29T09:00:00.000Z',
    Number.POSITIVE_INFINITY,
  );
  assert.ok('started' in dispatch);
  store.endDispatch(dispatch.started, { state: 'done', pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143' } }, '2026-09-29T09:03:20.000Z');
  const transcripts = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(
    join(transcripts, 'run-01.jsonl'),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      text: 'See [the docs](https://example.com/docs) for more.',
      usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      generationId: null,
    }) + '\n',
  );
  const app = createApp({ store, transcripts: new FileTranscriptSource(transcripts), css: '', logo: '', idiomorph: '', client: '' });
  return async (path: string): Promise<string> => (await app.request(path)).text();
};

const anchorsTo = (body: string, href: string): string[] =>
  [...body.matchAll(/<a\s[^>]*>/g)].map(([tag]) => tag).filter((tag) => tag.includes(` href="${href}"`));

const assertOpensInNewTab = (body: string, href: string, rel: string, where: string, times = 1): void => {
  const anchors = anchorsTo(body, href);
  assert.equal(anchors.length, times, `${where} links ${href} ${times} time(s)`);
  for (const anchor of anchors) {
    assert.match(anchor, /\starget="_blank"/, `${where} opens ${href} in a new tab`);
    assert.match(anchor, new RegExp(`\\srel="${rel}"`), `${where} sets rel on ${href}`);
  }
};

test('given a stored frontier ticket and a run tied to a ticket, both with GitHub URLs, when the Board and runs pages are requested, then each ticket number links to its URL in a new tab', async () => {
  const page = dashboard();

  assertOpensInNewTab(await page('/'), TICKET_URL, 'noopener noreferrer', '/');
  assertOpensInNewTab(await page('/workloads'), TICKET_URL, 'noopener noreferrer', '/workloads', 2);
});

test('given a stored repository whose github is owner/name, when the Board is requested, then the repository link opens in a new tab', async () => {
  assertOpensInNewTab(await dashboard()('/'), 'https://github.com/rameezk/forge', 'noopener noreferrer', '/');
});

test('given a run whose assistant message contains a markdown link, when the run page is requested, then the link opens in a new tab and keeps nofollow', async () => {
  assertOpensInNewTab(await dashboard()('/runs/run-01/transcript'), 'https://example.com/docs', 'noopener noreferrer nofollow', '/runs/run-01/transcript');
});

test('given the dashboard, when the Board, runs and run pages are requested, then nav links, run links, dispatch badges and the back link open in the same tab', async () => {
  const page = dashboard();
  const sameSiteAnchors = async (path: string): Promise<string[]> =>
    [...(await page(path)).matchAll(/<a(?=\s)[^>]*\shref="\/[^"]*"[^>]*>[\s\S]*?<\/a>/g)].map(([anchor]) => anchor);

  const runs = await sameSiteAnchors('/workloads');
  const work = await sameSiteAnchors('/');
  const run = await sameSiteAnchors('/runs/run-01');

  for (const href of ['/', '/workloads', '/runs/run-01']) {
    assert.ok(runs.some((anchor) => openingTag(anchor).includes(` href="${href}"`)), `the runs page links ${href}`);
  }
  for (const href of ['/', '/workloads']) {
    assert.ok(work.some((anchor) => openingTag(anchor).includes(` href="${href}"`)), `the Board links ${href}`);
  }
  assert.ok(run.some((anchor) => openingTag(anchor).includes(' href="/workloads"') && textOf(anchor) === '&larr; Workloads'), 'the run page has its back link');
  for (const anchor of [...runs, ...work, ...run]) {
    assert.doesNotMatch(openingTag(anchor), /\starget=/);
  }
});
