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

export interface SandboxedProcess {
  child: ChildProcess;
  stdout: Readable;
  stderr: Readable;
  harnessRan: Promise<boolean>;
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

export const spawnSandboxed = (
  sandbox: Sandbox,
  command: string,
  args: string[],
  { workDir, env }: { workDir: string; env: NodeJS.ProcessEnv },
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
    stderr: child.stderr as Readable,
    harnessRan: reportsExit(child.stdio[STATUS_FD] as Readable),
  };
};
