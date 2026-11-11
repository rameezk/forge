import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeCodeShell {
  bash: string;
  client: string;
}

export interface ClaudeCodeConfig {
  settings: string;
  instructions: string;
  plugin: string;
}

const MAX_SUBAGENT_DEPTH = 1;

const MAX_CONCURRENT_SUBAGENTS = 4;

export const PLUGIN_NAME = 'repository';

export const PLUGIN_CONTENT = ['skills', 'agents', 'commands'] as const;

export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

export const SHELL_VARIABLES = ['CLAUDE_CODE_SHELL', 'CLAUDE_CODE_SHELL_PREFIX'] as const;

export const claudeCodeSettings = ({ bash, client }: ClaudeCodeShell): Record<string, unknown> => ({
  env: {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(MAX_SUBAGENT_DEPTH),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(MAX_CONCURRENT_SUBAGENTS),
    CLAUDE_CODE_SHELL: bash,
    CLAUDE_CODE_SHELL_PREFIX: client,
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
  },
  attribution: { commit: '', pr: '' },
  disableAllHooks: true,
  apiKeyHelper: '',
  awsAuthRefresh: '',
  awsCredentialExport: '',
  gcpAuthRefresh: '',
  otelHeadersHelper: '',
});

const isEntry = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export const writeClaudeCodeConfig = ({
  dir,
  workDir,
  shell,
}: {
  dir: string;
  workDir: string;
  shell: ClaudeCodeShell;
}): ClaudeCodeConfig => {
  const plugin = join(dir, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: PLUGIN_NAME,
      description: "The repository's skills, agents and commands, linked by forge",
    }),
  );
  for (const name of PLUGIN_CONTENT) {
    const source = join(workDir, '.claude', name);
    if (isEntry(source)) symlinkSync(source, join(plugin, name));
  }
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify(claudeCodeSettings(shell)), { mode: 0o444 });
  const instructions = join(dir, 'CLAUDE.md');
  const imports = INSTRUCTION_FILES.filter((file) => isEntry(join(workDir, file))).map(
    (file) => `@${join(workDir, file)}`,
  );
  writeFileSync(instructions, `${imports.join('\n')}\n`, { mode: 0o444 });
  return { settings, instructions, plugin };
};
