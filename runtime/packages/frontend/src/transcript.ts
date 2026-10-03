import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { parseTranscript } from '@forge/shared';
import type { HarnessEvent } from '@forge/shared';

const SCAN_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

const parsedLine = (line: string): unknown => {
  if (line.trim() === '') return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

export interface TranscriptSource {
  read(ref: string): HarnessEvent[];
  scanRecords(ref: string, visit: (record: unknown) => boolean): void;
  size(ref: string): number | undefined;
  stream(ref: string): ReadableStream<Uint8Array>;
}

export class FileTranscriptSource implements TranscriptSource {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  read(ref: string): HarnessEvent[] {
    return parseTranscript(readFileSync(this.#path(ref), 'utf8'));
  }

  scanRecords(ref: string, visit: (record: unknown) => boolean): void {
    const path = this.#path(ref);
    if (statSync(path, { throwIfNoEntry: false }) === undefined) return;
    const fd = openSync(path, 'r');
    try {
      const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
      let pending = Buffer.alloc(0);
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        const buffered = Buffer.concat([pending, chunk.subarray(0, read)]);
        let start = 0;
        for (let end = buffered.indexOf(NEWLINE); end !== -1; end = buffered.indexOf(NEWLINE, start)) {
          const parsed = parsedLine(buffered.toString('utf8', start, end));
          start = end + 1;
          if (parsed !== undefined && !visit(parsed)) return;
        }
        pending = buffered.subarray(start);
        if (read === 0) break;
      }
      const last = parsedLine(pending.toString('utf8'));
      if (last !== undefined) visit(last);
    } finally {
      closeSync(fd);
    }
  }

  size(ref: string): number | undefined {
    return statSync(this.#path(ref), { throwIfNoEntry: false })?.size;
  }

  stream(ref: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(createReadStream(this.#path(ref))) as ReadableStream<Uint8Array>;
  }

  #path(ref: string): string {
    const path = resolve(this.#dir, ref);
    if (path !== this.#dir && !path.startsWith(this.#dir + sep)) {
      throw new Error(`transcript ref escapes the transcript directory: ${ref}`);
    }
    return path;
  }
}
