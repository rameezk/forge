import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillLoadTracker, type HarnessEvent } from '../src/index.ts';

const FILE = '/repo/.claude/skills/code-review/SKILL.md';

const tracker = (): SkillLoadTracker =>
  new SkillLoadTracker({
    root: '/repo',
    skills: new Map([['code-review', [FILE]]]),
    skillLines: new Map([[FILE, 40]]),
  });

const call = (id: string, skill: unknown, subagent?: string): HarnessEvent => ({
  type: 'tool_call',
  id,
  name: 'Skill',
  arguments: { skill },
  ...(subagent === undefined ? {} : { subagent }),
});

const result = (id: string, isError: boolean, subagent?: string): HarnessEvent => ({
  type: 'tool_result',
  id,
  isError,
  text: 'Launching skill: code-review',
  ...(subagent === undefined ? {} : { subagent }),
});

test('given a Skill tool call for a catalogued skill, when its result arrives, then the load is recorded in the call\'s scope and is complete', () => {
  const skills = tracker();

  const started = skills.observe(call('toolu_1', 'code-review', 'toolu_agent'));
  const finished = skills.observe(result('toolu_1', false, 'toolu_agent'));

  assert.deepEqual(started, {
    skill: 'code-review',
    source: 'read',
    subagent: 'toolu_agent',
    coverage: { coveredLines: 0, totalLines: 40 },
  });
  assert.deepEqual(finished?.coverage, { coveredLines: 40, totalLines: 40 });
  assert.equal(finished?.subagent, 'toolu_agent');
});

test('given a Skill tool call whose result is an error, when the result arrives, then the load stays uncovered', () => {
  const skills = tracker();

  skills.observe(call('toolu_1', 'code-review'));
  const finished = skills.observe(result('toolu_1', true));

  assert.deepEqual(finished?.coverage, { coveredLines: 0, totalLines: 40 });
});

test('given a Skill tool call naming a skill the catalogue lacks or no skill, when it is observed, then nothing is recorded', () => {
  const skills = tracker();

  assert.equal(skills.observe(call('toolu_1', 'unknown-skill')), null);
  assert.equal(skills.observe(call('toolu_2', 42)), null);
  assert.equal(skills.observe(call('toolu_3', '__proto__')), null);
  assert.equal(skills.observe(result('toolu_1', false)), null);
});

test('given a Skill tool call with a leading slash, when it is observed, then it counts as the named skill', () => {
  assert.equal(tracker().observe(call('toolu_1', '/code-review'))?.skill, 'code-review');
});

test('given the same skill loaded in the parent and in a subagent, when both are observed, then each keeps its own scope', () => {
  const skills = tracker();

  skills.observe(call('toolu_1', 'code-review'));
  skills.observe(result('toolu_1', false));
  const inSubagent = skills.observe(call('toolu_1', 'code-review', 'toolu_agent'));

  assert.equal(inSubagent?.subagent, 'toolu_agent');
  assert.deepEqual(inSubagent?.coverage, { coveredLines: 0, totalLines: 40 });
});

test('given a starting prompt that is a skill command, when it is observed as the prompt, then the load is complete and unscoped', () => {
  assert.deepEqual(tracker().observePrompt('/code-review the change'), {
    skill: 'code-review',
    source: 'prompt',
    subagent: null,
    coverage: { coveredLines: 40, totalLines: 40 },
  });
  assert.equal(tracker().observePrompt('review the change'), null);
});
