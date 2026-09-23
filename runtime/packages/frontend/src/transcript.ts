import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';

export interface TranscriptSource {
  read(ref: string): HarnessEvent[];
}

export class FileTranscriptSource implements TranscriptSource {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  read(ref: string): HarnessEvent[] {
    return readFileSync(join(this.#dir, ref), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as HarnessEvent);
  }
}
