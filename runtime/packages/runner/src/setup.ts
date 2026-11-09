import { spawn, type ChildProcess } from 'node:child_process';

export interface Setup {
  signal: AbortSignal;
  stage: (name: string) => void;
}

export class SetupTimedOut extends Error {}

export const STOP_GRACE_MS = 5000;

const UNITS: [string, number][] = [
  ['w', 604800],
  ['d', 86400],
  ['h', 3600],
  ['min', 60],
  ['s', 1],
];

export const spanLabel = (seconds: number): string => {
  const [unit, size] =
    UNITS.find(([, size]) => seconds >= size && seconds % size === 0) ??
    UNITS[UNITS.length - 1]!;
  return `${seconds / size}${unit}`;
};

export const killOnAbort = (child: ChildProcess, signal: AbortSignal): void => {
  const kill = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  if (signal.aborted) {
    kill();
    return;
  }
  signal.addEventListener('abort', kill, { once: true });
  child.once('close', () => signal.removeEventListener('abort', kill));
};

export interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const finish = (
  file: string,
  args: string[],
  { cwd, env, signal }: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<Finished> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: signal !== undefined,
    });
    if (signal !== undefined) killOnAbort(child, signal);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

export const boundedBySetupTimeout = async <Result>(
  { seconds, what = 'setup' }: { seconds: number; what?: string },
  work: (setup: Setup) => Promise<Result>,
): Promise<Result> => {
  const controller = new AbortController();
  let stage: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new SetupTimedOut(
          `${what} did not finish within ${spanLabel(seconds)}${stage === null ? '' : `, stuck in the ${stage}`}`,
        ),
      );
      controller.abort();
    }, seconds * 1000);
  });
  const running = work({
    signal: controller.signal,
    stage: (name) => {
      stage = name;
    },
  });
  const stopped = running.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await Promise.race([running, expired]);
  } catch (error) {
    if (controller.signal.aborted) {
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, STOP_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
