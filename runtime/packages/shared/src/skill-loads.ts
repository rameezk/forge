import { resolve } from 'node:path';
import type { HarnessEvent } from './events.ts';

export type SkillSource = 'prompt' | 'read';

export interface SkillLoad {
  skill: string;
  source: SkillSource;
  subagent: string | null;
}

export interface RunSkillLoad extends SkillLoad {
  runId: string;
  loadedAt: string;
}

export interface SkillCatalog {
  root: string;
  skills: ReadonlyMap<string, readonly string[]>;
}

const SKILL_COMMAND = /^\/([^ ]+)/;

const skillOfFile = (catalog: SkillCatalog, path: string): string | null => {
  const file = resolve(catalog.root, path.replace(/^@/, ''));
  for (const [name, files] of catalog.skills) {
    if (files.includes(file)) {
      return name;
    }
  }
  return null;
};

export const skillLoadOf = (
  event: HarnessEvent,
  catalog: SkillCatalog,
  isPrompt: boolean,
): SkillLoad | null => {
  const subagent = event.type === 'result' ? null : (event.subagent ?? null);
  if (isPrompt) {
    if (event.type !== 'message' || event.role !== 'user') {
      return null;
    }
    const name = SKILL_COMMAND.exec(event.text)?.[1];
    return name !== undefined && catalog.skills.has(name)
      ? { skill: name, source: 'prompt', subagent }
      : null;
  }
  if (event.type !== 'tool_call' || event.name !== 'read') {
    return null;
  }
  const { path } = (event.arguments ?? {}) as { path?: unknown };
  if (typeof path !== 'string') {
    return null;
  }
  const skill = skillOfFile(catalog, path);
  return skill === null ? null : { skill, source: 'read', subagent };
};
