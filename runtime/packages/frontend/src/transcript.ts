import { createReadStream, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { parseTranscript } from '@forge/shared';
import type { HarnessEvent } from '@forge/shared';

export interface TranscriptSource {
  read(ref: string): HarnessEvent[];
  records(ref: string): unknown[];
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

  records(ref: string): unknown[] {
    const path = this.#path(ref);
    if (statSync(path, { throwIfNoEntry: false }) === undefined) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (line.trim() === '') return [];
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
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
