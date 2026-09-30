import { spawn } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import type { Checkout } from './harness.ts';

const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.pi/skills'];

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'];

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const inside = (root: string, path: string): boolean => {
  try {
    const real = realpathSync(path);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
};

const isDirectory = (root: string, path: string): boolean =>
  inside(root, path) && statSync(path).isDirectory();

const isFile = (root: string, path: string): boolean =>
  inside(root, path) && statSync(path).isFile();

export const cloneCheckout = (
  github: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        'clone',
        '--quiet',
        '--filter=blob:none',
        '--',
        `https://github.com/${github}.git`,
        dir,
      ],
      { env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = stderr.trim();
      reject(
        new Error(
          `git could not clone ${github}${reason.length === 0 ? '' : `: ${reason}`}`,
        ),
      );
    });
  });

export const resolveCheckout = (dir: string): Checkout => {
  const root = realpathSync(dir);
  const file = (path: string): string | null =>
    isFile(root, join(root, path)) ? join(root, path) : null;
  return {
    root,
    skillPaths: SKILL_DIRS.map((skills) => join(root, skills)).filter((path) =>
      isDirectory(root, path),
    ),
    projectInstructions:
      CONTEXT_FILES.map(file).find((path) => path !== null) ?? null,
    systemPrompt: file('.pi/SYSTEM.md'),
    appendSystemPrompt: file('.pi/APPEND_SYSTEM.md'),
  };
};

const frontmatterOf = (content: string): Record<string, unknown> => {
  const normalized = content.replace(/\r\n?/g, '\n');
  const end = normalized.indexOf('\n---', 3);
  if (!normalized.startsWith('---') || end === -1) {
    return {};
  }
  const parsed: unknown = parse(normalized.slice(4, end));
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
};

const loadsAs = (path: string): string | null => {
  try {
    const { name, description } = frontmatterOf(readFileSync(path, 'utf8'));
    if (typeof description !== 'string' || description.trim() === '') {
      return null;
    }
    return typeof name === 'string' && name !== ''
      ? name
      : basename(dirname(path));
  } catch {
    return null;
  }
};

const statOf = (path: string): Stats | null => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

const skillFilesIn = (
  dir: string,
  topLevel: boolean,
  visited: Set<string>,
): string[] => {
  const real = realpathSync(dir);
  if (visited.has(real)) {
    return [];
  }
  visited.add(real);
  const entries = readdirSync(dir).sort();
  const skill = join(dir, 'SKILL.md');
  if (entries.includes('SKILL.md') && statOf(skill)?.isFile()) {
    return [skill];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statOf(path);
    if (stats?.isDirectory()) {
      return entry.startsWith('.') || entry === 'node_modules'
        ? []
        : skillFilesIn(path, false, visited);
    }
    return topLevel && stats?.isFile() && entry.endsWith('.md') ? [path] : [];
  });
};

export const requireSkill = (checkout: Checkout, name: string): void => {
  const matches = new Map<string, string>();
  if (SKILL_NAME.test(name)) {
    for (const skills of checkout.skillPaths) {
      for (const path of skillFilesIn(skills, true, new Set())) {
        const real = realpathSync(path);
        if (!matches.has(real) && loadsAs(path) === name) {
          matches.set(real, path);
        }
      }
    }
  }
  const paths = [...matches.values()];
  if (paths.length > 1) {
    throw new Error(
      `skill '${name}' is ambiguous in the checkout: ${paths
        .map((path) => relative(checkout.root, path))
        .join(', ')}`,
    );
  }
  const [path] = paths;
  if (path === undefined || !isFile(checkout.root, path)) {
    throw new Error(`skill '${name}' not found in the checkout`);
  }
};
