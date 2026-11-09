const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_TIME_ZONE = 'UTC';

export interface ServeConfig {
  stateDir: string;
  socketPath: string;
  maxConcurrent: number;
  timeZone: string;
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
  return {
    stateDir,
    socketPath,
    maxConcurrent: resolveMaxConcurrent(env.FORGE_MAX_CONCURRENT),
    timeZone: resolveTimeZone(env.FORGE_DASHBOARD_TIME_ZONE),
  };
};
