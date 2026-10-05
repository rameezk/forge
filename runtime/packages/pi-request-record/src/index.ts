import { writeSync } from 'node:fs';
import { recordOf, REQUEST_RECORD_FD_ENV } from './contract.ts';

export type {
  CacheMarker,
  Path,
  Reference,
  RequestEntry,
  RequestRecordLine,
  SystemPromptDefinition,
  ToolsDefinition,
} from './contract.ts';
export { REQUEST_RECORD_FD_ENV, SYSTEM_ROLES } from './contract.ts';

export interface BeforeProviderRequestEvent {
  type: 'before_provider_request';
  payload: unknown;
}

export interface ExtensionApi {
  on(
    event: 'before_provider_request',
    handler: (event: BeforeProviderRequestEvent) => unknown,
  ): void;
}

const writeLine = (fd: number, line: string): void => {
  const bytes = Buffer.from(`${line}\n`);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written);
  }
};

const recordFd = (env: NodeJS.ProcessEnv): number => {
  const value = env[REQUEST_RECORD_FD_ENV];
  const fd = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(fd) || fd <= 2) {
    throw new Error(
      `${REQUEST_RECORD_FD_ENV} must name the file descriptor the request record is written to`,
    );
  }
  return fd;
};

export default function requestRecordExtension(pi: ExtensionApi): void {
  const fd = recordFd(process.env);
  const recorded = new Set<string>();
  pi.on('before_provider_request', ({ payload }) => {
    for (const line of recordOf(payload)) {
      if (line.type !== 'request') {
        if (recorded.has(line.hash)) continue;
        recorded.add(line.hash);
      }
      writeLine(fd, JSON.stringify(line));
    }
    return undefined;
  });
}
