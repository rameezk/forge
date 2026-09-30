import { spawn } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Checkout } from './harness.ts';

export type SkillLoader = (options: {
  cwd: string;
  agentDir: string;
  skillPaths: string[];
  includeDefaults: boolean;
}) => {
  skills: { name: string; filePath: string }[];
  diagnostics: { collision?: { name: string; loserPath: string } }[];
};

export const loadPiSkills = async (piPackage: string): Promise<SkillLoader> => {
  const pi = (await import(
    pathToFileURL(join(piPackage, 'dist', 'index.js')).href
  )) as { loadSkills: SkillLoader };
  return pi.loadSkills;
};

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

const realpathOf = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const confine = (root: string, dir: string, visited: Set<string>): void => {
  const real = realpathSync(dir);
  if (visited.has(real)) {
    return;
  }
  visited.add(real);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      confine(root, path, visited);
    }
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const target = realpathOf(path);
    if (target === null) {
      continue;
    }
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(
        `'${relative(root, path)}' in the checkout's skills links outside the checkout`,
      );
    }
    if (statSync(target).isDirectory()) {
      confine(root, path, visited);
    }
  }
};

const skillsIn = (
  root: string,
  skillPaths: string[],
  loadSkills: SkillLoader,
): Map<string, string[]> => {
  const { skills, diagnostics } = loadSkills({
    cwd: root,
    agentDir: root,
    skillPaths,
    includeDefaults: false,
  });
  const files = new Map(skills.map(({ name, filePath }) => [name, [filePath]]));
  for (const { collision } of diagnostics) {
    if (collision !== undefined) {
      files.get(collision.name)?.push(collision.loserPath);
    }
  }
  return files;
};

export const resolveCheckout = (
  dir: string,
  loadSkills: SkillLoader,
): Checkout => {
  const root = realpathSync(dir);
  const file = (path: string): string | null =>
    isFile(root, join(root, path)) ? join(root, path) : null;
  const skillPaths = SKILL_DIRS.map((skills) => join(root, skills)).filter(
    (path) => isDirectory(root, path),
  );
  const visited = new Set<string>();
  for (const skills of skillPaths) {
    confine(root, skills, visited);
  }
  return {
    root,
    skillPaths,
    projectInstructions:
      CONTEXT_FILES.map(file).find((path) => path !== null) ?? null,
    systemPrompt: file('.pi/SYSTEM.md'),
    appendSystemPrompt: file('.pi/APPEND_SYSTEM.md'),
    skills: skillsIn(root, skillPaths, loadSkills),
  };
};

export const requireSkill = (checkout: Checkout, name: string): void => {
  const files = SKILL_NAME.test(name) ? checkout.skills.get(name) : undefined;
  if (files === undefined) {
    throw new Error(`skill '${name}' not found in the checkout`);
  }
  if (files.length > 1) {
    throw new Error(
      `skill '${name}' is ambiguous in the checkout: ${files
        .map((path) => relative(checkout.root, path))
        .sort()
        .join(', ')}`,
    );
  }
};
