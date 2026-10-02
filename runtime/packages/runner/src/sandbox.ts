import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface Sandbox {
  bwrap: string;
  home: string;
}

const STATUS_FD = 3;

const readOnly = (path: string): string[] => ['--ro-bind', path, path];

export const sandboxArgs = ({ home }: Sandbox, workDir: string): string[] => [
  '--unshare-user',
  '--disable-userns',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  '--die-with-parent',
  '--new-session',
  ...readOnly('/nix/store'),
  ...readOnly('/nix/var/nix/daemon-socket'),
  ...readOnly('/etc'),
  ...readOnly('/bin'),
  ...readOnly('/usr'),
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
  '--tmpfs',
  home,
  '--bind',
  workDir,
  workDir,
  '--remount-ro',
  '/',
  '--chdir',
  workDir,
  '--json-status-fd',
  String(STATUS_FD),
];

const STDERR_TAIL_CHARS = 4000;

export class SandboxUnavailable extends Error {}

export interface SandboxedProcess {
  child: ChildProcess;
  stdout: Readable;
  exited: Promise<Error | null>;
}

const isExitReport = (line: string): boolean => {
  try {
    const report: unknown = JSON.parse(line);
    return typeof report === 'object' && report !== null && 'exit-code' in report;
  } catch {
    return false;
  }
};

const reportsExit = (status: Readable): Promise<boolean> =>
  new Promise((resolve) => {
    let reports = '';
    status.setEncoding('utf8');
    status.on('data', (chunk: string) => {
      reports += chunk;
    });
    status.on('error', () => resolve(false));
    status.on('close', () => resolve(reports.split('\n').some(isExitReport)));
  });

const stderrTail = (stderr: Readable): Promise<string> =>
  new Promise((resolve) => {
    let tail = '';
    stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    stderr.on('close', () => resolve(tail.trim()));
  });

const exitOf = async (
  name: string,
  child: ChildProcess,
  ran: Promise<boolean>,
  tail: Promise<string>,
): Promise<Error | null> => {
  const closing = await new Promise<
    Error | { code: number | null; signal: NodeJS.Signals | null }
  >((resolve) => {
    child.on('error', resolve);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  if (!(await ran)) {
    const why = closing instanceof Error ? closing.message : await tail;
    return new SandboxUnavailable(`the workload sandbox could not start: ${why}`);
  }
  if (closing instanceof Error) {
    return closing;
  }
  const { code, signal } = closing;
  if (code === 0) {
    return null;
  }
  const reason = await tail;
  const how = code === null ? `on signal ${String(signal)}` : `with code ${code}`;
  return new Error(
    reason.length === 0 ? `${name} exited ${how}` : `${name} exited ${how}: ${reason}`,
  );
};

export const spawnSandboxed = (
  sandbox: Sandbox,
  command: string,
  args: string[],
  { name, workDir, env }: { name: string; workDir: string; env: NodeJS.ProcessEnv },
): SandboxedProcess => {
  const child = spawn(
    sandbox.bwrap,
    [...sandboxArgs(sandbox, workDir), '--', command, ...args],
    {
      cwd: workDir,
      env: { ...env, HOME: sandbox.home },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    },
  );
  return {
    child,
    stdout: child.stdout as Readable,
    exited: exitOf(
      name,
      child,
      reportsExit(child.stdio[STATUS_FD] as Readable),
      stderrTail(child.stderr as Readable),
    ),
  };
};
