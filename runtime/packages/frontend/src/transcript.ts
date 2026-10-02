import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseTranscript } from '@forge/shared';
import type { HarnessEvent } from '@forge/shared';

export interface TranscriptSource {
  read(ref: string): HarnessEvent[];
  size(ref: string): number | undefined;
}

export class FileTranscriptSource implements TranscriptSource {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  read(ref: string): HarnessEvent[] {
    return parseTranscript(readFileSync(this.#path(ref), 'utf8'));
  }

  size(ref: string): number | undefined {
    return statSync(this.#path(ref), { throwIfNoEntry: false })?.size;
  }

  #path(ref: string): string {
    const path = resolve(this.#dir, ref);
    if (path !== this.#dir && !path.startsWith(this.#dir + sep)) {
      throw new Error(`transcript ref escapes the transcript directory: ${ref}`);
    }
    return path;
  }
}
