import { matchesGlob } from 'node:path';

export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.github/**',
  '**/*.nix',
  '**/flake.lock',
  'infra/**',
  '**/*.tf',
  '**/*.tofu',
  '**/*.tfvars',
  '**/Dockerfile',
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/.claude/**',
  '**/.agents/**',
  '**/skills/**',
  '**/SKILL.md',
  '**/secrets/**',
  '**/.sops.yaml',
  '**/*.sops',
  '**/*.sops.*',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/.npmrc',
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/go.mod',
  '**/go.sum',
  '**/pyproject.toml',
  '**/requirements*.txt',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile',
  '**/Pipfile.lock',
  '**/Gemfile',
  '**/Gemfile.lock',
  '**/composer.json',
  '**/composer.lock',
  '**/pom.xml',
  '**/build.gradle',
  '**/build.gradle.kts',
  '**/*.lock',
];

export const DEFAULT_SIZE_CAP = 300;

export const protectedPathsOf = (repository: { protectedPaths?: readonly string[] }): readonly string[] => [
  ...DEFAULT_PROTECTED_PATHS,
  ...(repository.protectedPaths ?? []),
];

export const sizeCapOf = (repository: { autoMergeSizeCap?: number }): number =>
  repository.autoMergeSizeCap ?? DEFAULT_SIZE_CAP;

export const touchedProtectedPath = (
  files: readonly { filename: string; previous_filename?: string }[],
  patterns: readonly string[],
): string | null => {
  for (const { filename, previous_filename } of files) {
    for (const path of [filename, previous_filename]) {
      if (path !== undefined && patterns.some((pattern) => matchesGlob(path, pattern))) return path;
    }
  }
  return null;
};
