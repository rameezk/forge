import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCheckout, type SkillLoader } from '../src/checkout.ts';

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
