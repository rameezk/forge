import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
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

const loadsAs = (path: string, name: string): boolean => {
  try {
    const { name: declared, description } = frontmatterOf(
      readFileSync(path, 'utf8'),
    );
    return (
      (declared || basename(dirname(path))) === name &&
      typeof description === 'string' &&
      description.trim() !== ''
    );
  } catch {
    return false;
  }
};

export const hasSkill = (checkout: Checkout, name: string): boolean =>
  SKILL_NAME.test(name) &&
  checkout.skillPaths.some((skills) => {
    const path = join(skills, name, 'SKILL.md');
    return isFile(checkout.root, path) && loadsAs(path, name);
  });
