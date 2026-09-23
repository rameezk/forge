import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';
import { transcriptLine } from '@forge/shared';

export interface TranscriptWriter {
  readonly ref: string;
  append(event: HarnessEvent): void | Promise<void>;
  close(): void | Promise<void>;
}

export class FileTranscript implements TranscriptWriter {
  readonly ref: string;
  readonly #fd: number;

  private constructor(ref: string, fd: number) {
    this.ref = ref;
    this.#fd = fd;
  }

  static open(dir: string, runId: string): FileTranscript {
    const ref = `${runId}.jsonl`;
    return new FileTranscript(ref, openSync(join(dir, ref), 'a'));
  }

  append(event: HarnessEvent): void {
    writeSync(this.#fd, transcriptLine(event));
  }

  close(): void {
    closeSync(this.#fd);
  }
}
