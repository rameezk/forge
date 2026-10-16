const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 7787;
const DEFAULT_TIME_ZONE = 'UTC';

export interface ServeConfig {
  stateDir: string;
  hostname: string;
  port: number;
  timeZone: string;
}

const resolvePort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `FORGE_FRONTEND_PORT must be a valid port number, got '${value}'`,
    );
  }
  return port;
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
  return {
    stateDir,
    hostname: env.FORGE_FRONTEND_HOST ?? LOOPBACK,
    port: resolvePort(env.FORGE_FRONTEND_PORT),
    timeZone: resolveTimeZone(env.FORGE_DASHBOARD_TIME_ZONE),
  };
};
