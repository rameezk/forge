import type { DispatchOrder } from '@forge/shared';
import { isAbsolute } from 'node:path';

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_OPEN_PULL_REQUESTS = 5;
const DEFAULT_TIME_ZONE = 'UTC';

export interface ServeConfig {
  dispatchOrder: DispatchOrder;
  repositoryPriorities: Record<string, number>;
  stateDir: string;
  socketPath: string;
  maxConcurrent: number;
  maxOpenPullRequests: number | null;
  gradingRepositories: string[];
  autoMergeRepositories: string[];
  timeZone: string;
  deployStatusFile: string | null;
  repositoriesFile: string | null;
}

const resolveMaxConcurrent = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_MAX_CONCURRENT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `FORGE_MAX_CONCURRENT must be a positive integer, got '${value}'`,
    );
  }
  return limit;
};

const resolveMaxOpenPullRequests = (value: string | undefined): number | null => {
  if (value === undefined) return DEFAULT_MAX_OPEN_PULL_REQUESTS;
  if (value === 'null') return null;
  const limit = Number(value);
  if (value === '' || !Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `FORGE_MAX_OPEN_PULL_REQUESTS must be a positive integer or 'null', got '${value}'`,
    );
  }
  return limit;
};

const resolveDispatchOrder = (value: string | undefined): DispatchOrder => {
  if (value === undefined || value === 'oldest') return 'oldest';
  if (value === 'urgency') return value;
  throw new Error(`FORGE_DISPATCH_ORDER must be 'oldest' or 'urgency', got '${value}'`);
};

const resolveRepositoryPriorities = (value: string | undefined): Record<string, number> =>
  Object.fromEntries(
    (value ?? '')
      .split(',')
      .filter((entry) => entry !== '')
      .map((entry) => {
        const at = entry.lastIndexOf('=');
        const priority = Number(entry.slice(at + 1));
        if (at < 1 || at === entry.length - 1 || !Number.isInteger(priority)) {
          throw new Error(`FORGE_REPOSITORY_PRIORITIES must list name=integer pairs, got '${entry}'`);
        }
        return [entry.slice(0, at), priority];
      }),
  );

const resolveTimeZone = (value: string | undefined): string => {
  if (value === undefined) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(
      `FORGE_DASHBOARD_TIME_ZONE must be a valid IANA time zone, got '${value}'`,
    );
  }
  return value;
};

export const resolveServeConfig = (env: NodeJS.ProcessEnv): ServeConfig => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const socketPath = env.FORGE_FRONTEND_SOCKET;
  if (socketPath === undefined) {
    throw new Error('FORGE_FRONTEND_SOCKET is not set');
  }
  if (!isAbsolute(socketPath)) {
    throw new Error(
      `FORGE_FRONTEND_SOCKET must be an absolute path, got '${socketPath}'`,
    );
  }
  const deployStatusFile = env.FORGE_PULL_DEPLOY_STATUS_FILE ?? null;
  if (deployStatusFile !== null && !isAbsolute(deployStatusFile)) {
    throw new Error(
      `FORGE_PULL_DEPLOY_STATUS_FILE must be an absolute path, got '${deployStatusFile}'`,
    );
  }
  const repositoriesFile = env.FORGE_REPOSITORIES_FILE ?? null;
  if (repositoriesFile !== null && !isAbsolute(repositoriesFile)) {
    throw new Error(
      `FORGE_REPOSITORIES_FILE must be an absolute path, got '${repositoriesFile}'`,
    );
  }
  return {
    stateDir,
    socketPath,
    maxConcurrent: resolveMaxConcurrent(env.FORGE_MAX_CONCURRENT),
    maxOpenPullRequests: resolveMaxOpenPullRequests(env.FORGE_MAX_OPEN_PULL_REQUESTS),
    dispatchOrder: resolveDispatchOrder(env.FORGE_DISPATCH_ORDER),
    repositoryPriorities: resolveRepositoryPriorities(env.FORGE_REPOSITORY_PRIORITIES),
    gradingRepositories: (env.FORGE_GRADING_REPOSITORIES ?? '').split(',').filter((name) => name !== ''),
    autoMergeRepositories: (env.FORGE_AUTO_MERGE_REPOSITORIES ?? '').split(',').filter((name) => name !== ''),
    timeZone: resolveTimeZone(env.FORGE_DASHBOARD_TIME_ZONE),
    deployStatusFile,
    repositoriesFile,
  };
};
