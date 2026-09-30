import {
  isHeaderValue,
  queryTicket,
  type Fetch,
  type TicketState,
} from '@forge/shared';
import { resolveWorker, type RepositoryConfig } from './config.ts';
import { cloneCheckout, resolveCheckout } from './checkout.ts';
import { launchWorkload, readRuntimeConfig } from './workload.ts';

const USAGE = 'usage: forge-dispatch <repository> <issue>';

const FORGE_READY = 'forge:ready';

const READY_FOR_AGENT = 'ready-for-agent';

const refusal = (ticket: TicketState): string | null => {
  if (!ticket.open) return 'it is closed';
  if (!ticket.labels.includes(READY_FOR_AGENT)) {
    return `it is not labelled ${READY_FOR_AGENT}`;
  }
  if (ticket.blockedBy > 0) return 'it has open blockers';
  if (!ticket.labels.includes(FORGE_READY)) {
    return `it is not labelled ${FORGE_READY}`;
  }
  return null;
};

const fillPrompt = (
  template: string,
  github: string,
  ticket: TicketState,
): string =>
  template
    .replaceAll('{repo}', github)
    .replaceAll('{issue}', String(ticket.number))
    .replaceAll('{url}', ticket.url);

const githubToken = (env: NodeJS.ProcessEnv): string => {
  const token = env.GITHUB_TOKEN?.trim() ?? '';
  if (token === '') throw new Error('GitHub token missing');
  if (!isHeaderValue(token)) throw new Error('GitHub token malformed');
  return token;
};

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

  const ticket = await queryTicket(
    fetch,
    githubToken(env),
    repository.github,
    Number(issue),
  );
  const refused = refusal(ticket);
  if (refused !== null) {
    console.error(`${name}#${ticket.number} is not dispatchable: ${refused}`);
    return 1;
  }

  return launchWorkload({
    config,
    worker: {
      ...worker,
      prompt: fillPrompt(worker.prompt, repository.github, ticket),
    },
    env,
    ticket: { repository: name, number: ticket.number, url: ticket.url },
    openWorkspace: async (workDir) => {
      await cloneCheckout(repository.github, workDir, env);
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
