import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { createApp, FileTranscriptSource, parseDeployStatus } from '../src/index.ts';
import type { DeployStatus } from '../src/index.ts';
import { textOf } from './html.ts';

const RUNNING = '1111111111111111111111111111111111111111';
const FORGE = '3a822d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UPSTREAM_HEAD = '369554fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const status = (overrides: Partial<DeployStatus> = {}): DeployStatus => ({
  running: RUNNING,
  head: RUNNING,
  error: null,
  forge: FORGE,
  upstream: 'rameezk/forge',
  upstreamHead: FORGE,
  behind: 0,
  ...overrides,
});

const pageWith = async (page: string, deployStatus?: () => DeployStatus | null): Promise<string> => {
  const app = createApp({
    store: Store.open(':memory:'),
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    ...(deployStatus === undefined ? {} : { deployStatus }),
  });
  return (await app.request(page)).text();
};

const footerOf = (body: string): string => {
  const footer = body.match(/<footer[\s\S]*?<\/footer>/)?.[0];
  assert.ok(footer, 'the page has a footer');
  return footer;
};

const forgeOf = (footer: string): string => {
  const forge = footer.match(/<div[^>]*\sdata-forge-status[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(forge, 'the footer shows the forge status');
  return forge;
};

const commitLink = (footer: string): { href: string; text: string } => {
  const link = footer.match(/<a\s[^>]*\bdata-forge-commit\b[^>]*>[\s\S]*?<\/a>/)?.[0];
  assert.ok(link, 'the forge commit is a link');
  return { href: /href="([^"]*)"/.exec(link)![1]!, text: textOf(link) };
};

const pillOf = (footer: string): string | undefined => footer.match(/<[^>]*\sdata-forge-pill[^>]*>[\s\S]*?<\/span>/)?.[0];

test('given the running forge commit is upstream head, when the Board and the Workloads page are requested, then each footer shows Forge, the short commit linked to its page and a green latest pill', async () => {
  for (const page of ['/', '/workloads']) {
    const footer = footerOf(await pageWith(page, () => status()));

    assert.match(textOf(footer), /Times in UTC/, page);
    assert.match(textOf(forgeOf(footer)), /^Forge 3a822d0 latest$/, page);
    assert.deepEqual(commitLink(footer), { href: `https://github.com/rameezk/forge/commit/${FORGE}`, text: '3a822d0' }, page);
    assert.match(pillOf(footer) ?? '', /bg-success-soft/, page);
  }
});

test('given the box is 3 commits behind upstream, when a page is requested, then the footer shows a neutral 3 behind pill and the commit links to the compare view', async () => {
  const footer = footerOf(await pageWith('/workloads', () => status({ upstreamHead: UPSTREAM_HEAD, behind: 3 })));

  assert.match(textOf(forgeOf(footer)), /^Forge 3a822d0 3 behind$/);
  assert.equal(commitLink(footer).href, `https://github.com/rameezk/forge/compare/${FORGE}...${UPSTREAM_HEAD}`);
  assert.match(pillOf(footer) ?? '', /bg-line/);
  assert.doesNotMatch(pillOf(footer) ?? '', /bg-(success|warning|error)-soft/);
});

test('given a fork as the upstream source, when a page is requested, then the links point at the fork', async () => {
  const footer = footerOf(await pageWith('/workloads', () => status({ upstream: 'someone/forge-fork', upstreamHead: UPSTREAM_HEAD, behind: 1 })));

  assert.equal(commitLink(footer).href, `https://github.com/someone/forge-fork/compare/${FORGE}...${UPSTREAM_HEAD}`);
});

test('given a running forge commit and no upstream fields, when a page is requested, then the footer shows the commit with no pill and no error', async () => {
  const footer = footerOf(await pageWith('/workloads', () => status({ upstream: null, upstreamHead: null, behind: null })));

  assert.match(textOf(forgeOf(footer)), /^Forge 3a822d0$/);
  assert.equal(pillOf(footer), undefined);
  assert.doesNotMatch(footer, /<a\s[^>]*data-forge-commit/);
  assert.doesNotMatch(textOf(footer), /error|failed/i);
});

test('given a status written before the forge fields existed, when it is read, then the forge fields are unknown', () => {
  assert.deepEqual(parseDeployStatus('{"running":"abc","head":"abc","error":null}'), {
    running: 'abc',
    head: 'abc',
    error: null,
    forge: null,
    upstream: null,
    upstreamHead: null,
    behind: null,
  });
});

test('given a status with every forge field and one it does not know, when it is read, then the forge fields come through', () => {
  const text = JSON.stringify({ running: RUNNING, head: RUNNING, error: null, forge: FORGE, upstream: 'rameezk/forge', upstreamHead: UPSTREAM_HEAD, behind: 3, template: 'x' });

  assert.deepEqual(parseDeployStatus(text), status({ upstreamHead: UPSTREAM_HEAD, behind: 3 }));
});

test('given forge fields of the wrong shape, when the status is read, then each reads as unknown', () => {
  const text = JSON.stringify({ forge: 'not a commit', upstream: 'javascript:alert(1)', upstreamHead: 7, behind: -2 });

  assert.deepEqual(parseDeployStatus(text), { running: null, head: null, error: null, forge: null, upstream: null, upstreamHead: null, behind: null });
  for (const upstream of ['../forge', 'owner/..', './forge']) assert.equal(parseDeployStatus(JSON.stringify({ upstream }))?.upstream, null, upstream);
});

test('given no deploy status, when a page is requested, then the footer shows only the time zone', async () => {
  for (const deployStatus of [undefined, () => null]) {
    const footer = footerOf(await pageWith('/workloads', deployStatus));

    assert.equal(textOf(footer), 'Times in UTC');
    assert.doesNotMatch(footer, /data-forge-status/);
  }
});

test('given a status with an error, when the Board and the Workloads page are requested, then each footer shows a red deploy failed pill linking to the Board error box beside the forge commit the box runs', async () => {
  for (const page of ['/', '/workloads']) {
    const footer = footerOf(await pageWith(page, () => status({ error: 'building the system failed', upstreamHead: UPSTREAM_HEAD, behind: 3 })));

    const pill = footer.match(/<a\s[^>]*\bdata-deploy-failed\b[^>]*>[\s\S]*?<\/a>/)?.[0];
    assert.ok(pill, page);
    assert.equal(/href="([^"]*)"/.exec(pill)![1], '/#deploy-error', page);
    assert.equal(textOf(pill), 'deploy failed', page);
    assert.match(pill, /bg-error-soft/, page);
    assert.match(textOf(forgeOf(footer)), /^Forge 3a822d0 3 behind deploy failed$/, page);
  }
});

test('given a status with an error, when the Board is requested, then it shows the error in the box the pill links to', async () => {
  const body = await pageWith('/', () => status({ error: 'building the system failed' }));

  assert.match(body, /<[^>]*\sid="deploy-error"[^>]*>[^<]*building the system failed/);
});

test('given a status with no error, when a page is requested, then the footer has no deploy failed pill', async () => {
  assert.doesNotMatch(footerOf(await pageWith('/workloads', () => status())), /deploy failed|data-deploy-failed/);
});

test('given a status with an error and no forge commit, when a page is requested, then the footer still shows the deploy failed pill', async () => {
  const footer = footerOf(await pageWith('/workloads', () => status({ error: 'boom', forge: null, upstream: null, upstreamHead: null, behind: null })));

  assert.match(textOf(forgeOf(footer)), /deploy failed$/);
});
