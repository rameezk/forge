import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneCheckout, resolveCheckout, type SkillLoader } from '../src/checkout.ts';
import { boundedBySetupTimeout } from '../src/setup.ts';
import { alive } from './helpers.ts';

const noSkills: SkillLoader = () => ({ skills: [], diagnostics: [] });

const checkoutWith = (): string =>
  mkdtempSync(join(tmpdir(), 'forge-checkout-'));

const filesIn = (dir: string, count: number): void => {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(dir, `file-${index}.md`), 'x\n');
  }
};

test('given a checkout with a large but allowed skills tree, when its skills are resolved, then the event loop keeps turning throughout the walk', async () => {
  const dir = checkoutWith();
  for (let skill = 0; skill < 40; skill += 1) {
    filesIn(join(dir, '.claude', 'skills', `skill-${skill}`), 100);
  }
  let turns = 0;
  const timer = setInterval(() => {
    turns += 1;
  }, 1);

  try {
    await resolveCheckout(dir, noSkills);
  } finally {
    clearInterval(timer);
  }

  assert.ok(turns > 0, `the event loop turned ${turns} times during the walk`);
});

test('given a checkout whose skills hold more than 10,000 entries, when its skills are resolved, then setup fails naming the cap of 10,000 entries', async () => {
  const dir = checkoutWith();
  filesIn(join(dir, '.claude', 'skills', 'big'), 10_001);

  await assert.rejects(
    async () => resolveCheckout(dir, noSkills),
    /more than 10,000 entries/,
  );
});

test('given a checkout whose skills hold exactly 10,000 entries, when its skills are resolved, then it resolves', async () => {
  const dir = checkoutWith();
  filesIn(join(dir, '.claude', 'skills', 'big'), 9_999);

  await resolveCheckout(dir, noSkills);
});

test('given a checkout whose skills hold 10,000 entries or fewer directly, but more once its safe links are followed, when its skills are resolved, then setup fails naming the cap', async () => {
  const dir = checkoutWith();
  filesIn(join(dir, '.claude', 'skills', 'own'), 6_000);
  filesIn(join(dir, 'docs'), 6_000);
  symlinkSync('../../docs', join(dir, '.claude', 'skills', 'shared'));

  await assert.rejects(
    async () => resolveCheckout(dir, noSkills),
    /more than 10,000 entries/,
  );
});

test('given a clone stopped at the setup timeout while a child process git started is still running, when the setup ends, then that child process is no longer running', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'forge-fake-git-'));
  const pidFile = join(bin, 'child.pid');
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nwait\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);

  await assert.rejects(
    boundedBySetupTimeout({ seconds: 0.5 }, async (setup) => {
      setup.stage('clone');
      await cloneCheckout('owner/repo', join(bin, 'work'), { PATH: `${bin}:${process.env.PATH}` }, {
        blobless: true,
        signal: setup.signal,
      });
    }),
    /^Error: setup did not finish within 0\.5s, stuck in the clone$/,
  );

  assert.ok(existsSync(pidFile));
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(alive(child), false);
});
