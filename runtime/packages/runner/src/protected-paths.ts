export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.github/**',
  '**/*.nix',
  '**/flake.lock',
  'infra/**',
  '**/*.tf',
  '**/*.tofu',
  '**/*.tfvars',
  '**/Dockerfile*',
  '**/*.Dockerfile',
  '**/CODEOWNERS',
  '**/.gitmodules',
  '**/.mcp.json',
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

const globToRegExp = (pattern: string): RegExp => {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      if (pattern.charAt(index + 2) === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
};

export const touchedProtectedPath = (
  files: readonly { filename: string; previous_filename?: string }[],
  patterns: readonly string[],
): string | null => {
  const matchers = patterns.map(globToRegExp);
  for (const { filename, previous_filename } of files) {
    for (const path of [filename, previous_filename]) {
      if (path !== undefined && matchers.some((matcher) => matcher.test(path))) return path;
    }
  }
  return null;
};
