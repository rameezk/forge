import { readFileSync } from 'node:fs';
import {
  isHeaderValue,
  offFrontier,
  queryTicket,
  type Fetch,
  type TicketState,
} from '@forge/shared';
import { resolveWorker, type RepositoryConfig } from './config.ts';
import { cloneCheckout, resolveCheckout } from './checkout.ts';
import { launchWorkload, readRuntimeConfig } from './workload.ts';

const USAGE = 'usage: forge-dispatch <repository> <issue>';

const FORGE_READY = 'forge:ready';

const refusal = (ticket: TicketState): string | null =>
  offFrontier(ticket) ??
  (ticket.labels.includes(FORGE_READY) ? null : `it is not labelled ${FORGE_READY}`);

const fillPrompt = (
  template: string,
  github: string,
  ticket: TicketState,
): string =>
  template
    .replaceAll('{repo}', github)
    .replaceAll('{issue}', String(ticket.number))
    .replaceAll('{url}', ticket.url);

const readTokenFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
};

const unquoted = (value: string): string =>
  /^(["'])(.*)\1$/s.exec(value)?.[2] ?? value;

const githubToken = (env: NodeJS.ProcessEnv): string => {
  const path = env.FORGE_GITHUB_TOKEN_FILE;
  if (path === undefined) {
    throw new Error('FORGE_GITHUB_TOKEN_FILE is not set');
  }
  const token =
    readTokenFile(path)
      .split(/\r?\n/)
      .flatMap((line) => {
        const equals = line.indexOf('=');
        return equals !== -1 && line.slice(0, equals).trim() === 'GITHUB_TOKEN'
          ? [unquoted(line.slice(equals + 1).trim())]
          : [];
      })
      .at(-1) ?? '';
  if (token === '') throw new Error('GitHub token missing');
  if (!isHeaderValue(token)) throw new Error('GitHub token malformed');
  return token;
};

const withoutGithubToken = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== 'GITHUB_TOKEN'),
  );

const repositoryNamed = (
  repositories: Record<string, RepositoryConfig> | undefined,
  name: string,
): RepositoryConfig & { worker: string } => {
  const repository =
    repositories !== undefined && Object.hasOwn(repositories, name)
      ? repositories[name]
      : undefined;
  if (repository === undefined) {
    throw new Error(`unknown repository '${name}'`);
  }
  if (repository.worker === undefined) {
    throw new Error(`repository '${name}' declares no worker`);
  }
  return { github: repository.github, worker: repository.worker };
};

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
): Promise<number> => {
  const [name, issue, ...rest] = argv;
  if (
    name === undefined ||
    issue === undefined ||
    rest.length > 0 ||
    !/^[1-9][0-9]*$/.test(issue)
  ) {
    throw new Error(USAGE);
  }
  const config = readRuntimeConfig(env);
  const repository = repositoryNamed(config.repositories, name);
  const worker = resolveWorker(config, repository.worker);

  const token = githubToken(env);
  const ticket = await queryTicket(
    fetch,
    token,
    repository.github,
    Number(issue),
  );
  const refused = refusal(ticket);
  if (refused !== null) {
    console.error(`${name}#${ticket.number} is not dispatchable: ${refused}`);
    return 1;
  }

  const workloadEnv = withoutGithubToken(env);
  return launchWorkload({
    config,
    worker: {
      ...worker,
      prompt: fillPrompt(worker.prompt, repository.github, ticket),
    },
    env: workloadEnv,
    secrets: [token],
    ticket: { repository: name, number: ticket.number, url: ticket.url },
    openWorkspace: async (workDir) => {
      await cloneCheckout(repository.github, workDir, workloadEnv);
      return { workDir, checkout: resolveCheckout(workDir) };
    },
  });
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
