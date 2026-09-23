import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseTranscript } from '@forge/shared';
import type { HarnessEvent } from '@forge/shared';

export interface TranscriptSource {
  read(ref: string): HarnessEvent[];
}

export class FileTranscriptSource implements TranscriptSource {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = resolve(dir);
  }

  read(ref: string): HarnessEvent[] {
    const path = resolve(this.#dir, ref);
    if (path !== this.#dir && !path.startsWith(this.#dir + sep)) {
      throw new Error(`transcript ref escapes the transcript directory: ${ref}`);
    }
    return parseTranscript(readFileSync(path, 'utf8'));
  }
}
