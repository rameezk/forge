import { resolve } from 'node:path';
import type { HarnessEvent } from './events.ts';

export type SkillSource = 'prompt' | 'read';

export interface SkillCoverage {
  coveredLines: number;
  totalLines: number;
}

export interface SkillLoad {
  skill: string;
  source: SkillSource;
  subagent: string | null;
  coverage: SkillCoverage | null;
}

export interface RunSkillLoad extends SkillLoad {
  runId: string;
  loadedAt: string;
}

export interface SkillCatalog {
  root: string;
  skills: ReadonlyMap<string, readonly string[]>;
  skillLines: ReadonlyMap<string, number>;
}

type Range = readonly [number, number];

interface Tracked {
  skill: string;
  source: SkillSource;
  subagent: string | null;
  total: number | null;
  ranges: Range[];
}

interface PendingRead {
  tracked: Tracked;
  start: number;
  limit: number | undefined;
}

const SKILL_COMMAND = /^\/([^ ]+)/;

const SHOWING_LINES =
  /\n\n\[Showing lines (\d+)-(\d+) of \d+(?: \([^)]*\))?\. Use offset=\d+ to continue\.\]$/;

const skillOfFile = (
  catalog: SkillCatalog,
  path: string,
): { skill: string; file: string } | null => {
  const file = resolve(catalog.root, path.replace(/^@/, ''));
  for (const [skill, files] of catalog.skills) {
    if (files.includes(file)) {
      return { skill, file };
    }
  }
  return null;
};

const scopeOf = (event: HarnessEvent): string | null =>
  event.type === 'result' ? null : (event.subagent ?? null);

const coveredBy = (ranges: readonly Range[], total: number): number => {
  let covered = 0;
  let reached = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const end = Math.min(to, total);
    const start = Math.max(from, reached + 1);
    if (end >= start) {
      covered += end - start + 1;
      reached = end;
    }
  }
  return covered;
};

const scopedKey = (subagent: string | null, name: string): string =>
  `${subagent ?? ''}\0${name}`;

const readStart = (offset: unknown): number =>
  typeof offset === 'number' && offset > 1 ? Math.floor(offset) : 1;

const readLimit = (limit: unknown): number | undefined =>
  typeof limit === 'number' && limit >= 0 ? Math.floor(limit) : undefined;

export class SkillLoadTracker {
  readonly #catalog: SkillCatalog;
  readonly #loads = new Map<string, Tracked>();
  readonly #reads = new Map<string, PendingRead>();

  constructor(catalog: SkillCatalog) {
    this.#catalog = catalog;
  }

  observe(event: HarnessEvent): SkillLoad | null {
    if (event.type === 'message' && event.role === 'user') {
      return this.#prompt(event.text, scopeOf(event));
    }
    if (event.type === 'tool_call' && event.name === 'read') {
      return this.#readStarted(event.id, event.arguments, scopeOf(event));
    }
    if (event.type === 'tool_result') {
      return this.#readFinished(event.id, event.isError, event.text, scopeOf(event));
    }
    return null;
  }

  #track(
    skill: string,
    file: string,
    source: SkillSource,
    subagent: string | null,
  ): Tracked {
    const key = scopedKey(subagent, skill);
    const existing = this.#loads.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const tracked: Tracked = {
      skill,
      source,
      subagent,
      total: this.#catalog.skillLines.get(file) ?? null,
      ranges: [],
    };
    this.#loads.set(key, tracked);
    return tracked;
  }

  #snapshot({ skill, source, subagent, total, ranges }: Tracked): SkillLoad {
    return {
      skill,
      source,
      subagent,
      coverage:
        total === null
          ? null
          : { coveredLines: coveredBy(ranges, total), totalLines: total },
    };
  }

  #prompt(text: string, subagent: string | null): SkillLoad | null {
    const name = SKILL_COMMAND.exec(text)?.[1];
    const file = name === undefined ? undefined : this.#catalog.skills.get(name)?.[0];
    if (name === undefined || file === undefined) {
      return null;
    }
    const tracked = this.#track(name, file, 'prompt', subagent);
    if (tracked.total !== null) {
      tracked.ranges.push([1, tracked.total]);
    }
    return this.#snapshot(tracked);
  }

  #readStarted(
    id: string,
    args: unknown,
    subagent: string | null,
  ): SkillLoad | null {
    const { path, offset, limit } = (args ?? {}) as Record<string, unknown>;
    const found =
      typeof path === 'string' ? skillOfFile(this.#catalog, path) : null;
    if (found === null) {
      return null;
    }
    const tracked = this.#track(found.skill, found.file, 'read', subagent);
    this.#reads.set(scopedKey(subagent, id), {
      tracked,
      start: readStart(offset),
      limit: readLimit(limit),
    });
    return this.#snapshot(tracked);
  }

  #readFinished(
    id: string,
    isError: boolean,
    text: string,
    subagent: string | null,
  ): SkillLoad | null {
    const key = scopedKey(subagent, id);
    const read = this.#reads.get(key);
    if (read === undefined) {
      return null;
    }
    this.#reads.delete(key);
    const { tracked, start, limit } = read;
    if (!isError) {
      const shown = SHOWING_LINES.exec(text);
      const end =
        shown !== null
          ? Number(shown[2])
          : limit !== undefined
            ? start + limit - 1
            : tracked.total;
      const from = shown !== null ? Number(shown[1]) : start;
      if (end !== null) {
        tracked.ranges.push([from, end]);
      }
    }
    return this.#snapshot(tracked);
  }
}
