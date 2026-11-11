import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { GITHUB_TOKEN_FILE_ENV } from './github-token-file.ts';

export interface Sandbox {
  bwrap: string;
  home: string;
}

const STATUS_FD = 3;

const NIXOS_ENVIRONMENT_MARKER = { __NIXOS_SET_ENVIRONMENT_DONE: '1' };

export const REQUEST_RECORD_FD = 4;

export const BROKER_DIR = '/run/forge-tools';

export type SandboxRole = 'workload' | 'tools';

export interface BrokerMount {
  dir: string;
  role: SandboxRole;
}

export interface SandboxLayout {
  readOnlyHome?: boolean;
  lockedFiles?: { source: string; at: string }[];
}

const readOnlyAt = (path: string, at: string): string[] => ['--ro-bind', path, at];

const readOnly = (path: string): string[] => readOnlyAt(path, path);

export const sandboxArgs = (
  { home }: Sandbox,
  workDir: string,
  agentDir?: string,
  writableDirs: string[] = [],
  readOnlyDirs: string[] = [],
  { dir: brokerDir, role }: BrokerMount = { dir: '', role: 'workload' },
  { readOnlyHome = false, lockedFiles = [] }: SandboxLayout = {},
): string[] => [
  '--unshare-user',
  '--disable-userns',
  '--unshare-pid',
  ...(role === 'tools' ? ['--as-pid-1'] : []),
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
  ...(readOnlyHome ? ['--remount-ro', home] : []),
  ...(agentDir === undefined ? [] : readOnly(agentDir)),
  ...readOnlyDirs.flatMap(readOnly),
  ...writableDirs.flatMap((dir) => ['--bind', dir, dir]),
  ...lockedFiles.flatMap(({ source, at }) => readOnlyAt(source, at)),
  ...(brokerDir === '' ? [] : readOnlyAt(brokerDir, BROKER_DIR)),
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

export class SignalDeath extends Error {
  readonly harness: string;
  readonly signal: string;
  readonly reason: string;

  constructor(harness: string, signal: string, reason: string) {
    super(reason === '' ? `${harness} was killed by ${signal}` : `${harness} was killed by ${signal}: ${reason}`);
    this.harness = harness;
    this.signal = signal;
    this.reason = reason;
  }
}

const SIGNAL_EXIT_BASE = 128;

const SIGNAL_NAMES = new Map<number, string>();
for (const [name, number] of Object.entries(constants.signals)) {
  if (!SIGNAL_NAMES.has(number)) SIGNAL_NAMES.set(number, name);
}

const signalOfExit = (code: number | null, signal: NodeJS.Signals | null): string | null => {
  if (code === null) return signal;
  return code > SIGNAL_EXIT_BASE ? (SIGNAL_NAMES.get(code - SIGNAL_EXIT_BASE) ?? null) : null;
};

export interface SandboxedProcess {
  child: ChildProcess;
  stdout: Readable;
  requestRecord: Readable;
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
  role: SandboxRole,
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
    return new SandboxUnavailable(`the ${role} sandbox could not start: ${why}`);
  }
  if (closing instanceof Error) {
    return closing;
  }
  const { code, signal } = closing;
  if (code === 0) {
    return null;
  }
  const reason = await tail;
  const killedBy = role === 'workload' ? signalOfExit(code, signal) : null;
  if (killedBy !== null) {
    return new SignalDeath(name, killedBy, reason);
  }
  const how = code === null ? `on signal ${String(signal)}` : `with code ${code}`;
  return new Error(
    reason.length === 0 ? `${name} exited ${how}` : `${name} exited ${how}: ${reason}`,
  );
};

export const spawnSandboxed = (
  sandbox: Sandbox,
  command: string,
  args: string[],
  {
    name,
    workDir,
    agentDir,
    writableDirs,
    readOnlyPaths = [],
    env,
    broker,
    prefix = [],
    input,
    layout,
  }: {
    name: string;
    workDir: string;
    agentDir?: string;
    writableDirs?: string[];
    readOnlyPaths?: string[];
    env: NodeJS.ProcessEnv;
    broker?: BrokerMount;
    prefix?: string[];
    input?: string;
    layout?: SandboxLayout;
  },
): SandboxedProcess => {
  const tokenFile = env[GITHUB_TOKEN_FILE_ENV];
  const [launcher = sandbox.bwrap, ...launcherArgs] = [...prefix, sandbox.bwrap];
  const child = spawn(
    launcher,
    [
      ...launcherArgs,
      ...sandboxArgs(
        sandbox,
        workDir,
        agentDir,
        writableDirs,
        tokenFile === undefined ? readOnlyPaths : [...readOnlyPaths, dirname(tokenFile)],
        broker,
        layout,
      ),
      '--',
      command,
      ...args,
    ],
    {
      cwd: workDir,
      env: { ...env, ...NIXOS_ENVIRONMENT_MARKER, HOME: sandbox.home },
      stdio: [
        input === undefined ? 'ignore' : 'pipe',
        'pipe',
        'pipe',
        'pipe',
        broker?.role === 'tools' ? 'ignore' : 'pipe',
      ],
    },
  );
  if (input !== undefined) {
    const stdin = child.stdin as Writable;
    stdin.on('error', () => undefined);
    stdin.end(input);
  }
  return {
    child,
    stdout: child.stdout as Readable,
    requestRecord: child.stdio[REQUEST_RECORD_FD] as Readable,
    exited: exitOf(
      broker?.role ?? 'workload',
      name,
      child,
      reportsExit(child.stdio[STATUS_FD] as Readable),
      stderrTail(child.stderr as Readable),
    ),
  };
};
