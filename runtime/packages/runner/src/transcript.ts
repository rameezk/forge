import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';
import { rawEventsRef, transcriptLine } from '@forge/shared';

const TOOL_PAYLOAD_CAP_CHARS = 32 * 1024;

const REDACTED = '[redacted]';

const capped = (text: string): string =>
  text.length <= TOOL_PAYLOAD_CAP_CHARS
    ? text
    : `${text.slice(0, TOOL_PAYLOAD_CAP_CHARS)}\n[truncated ${text.length - TOOL_PAYLOAD_CAP_CHARS} characters]`;

export interface TranscriptPolicy {
  record(event: HarnessEvent): HarnessEvent;
  redact(text: string): string;
  redactValue(value: unknown): unknown;
}

export const transcriptPolicy = (secrets: string[]): TranscriptPolicy => {
  const hidden = secrets.filter((secret) => secret.length > 0);
  const redact = (text: string): string =>
    hidden.reduce(
      (redacted, secret) => redacted.replaceAll(secret, REDACTED),
      text,
    );
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redact(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          redact(key),
          redactValue(field),
        ]),
      );
    }
    return value;
  };
  const record = (event: HarnessEvent): HarnessEvent => {
    switch (event.type) {
      case 'message':
        return { ...event, text: redact(event.text) };
      case 'tool_call': {
        const redacted = redactValue(event.arguments);
        const json = JSON.stringify(redacted) ?? '';
        return {
          ...event,
          arguments:
            json.length <= TOOL_PAYLOAD_CAP_CHARS ? redacted : capped(json),
        };
      }
      case 'tool_result':
        return { ...event, text: capped(redact(event.text)) };
      case 'result':
        return event.error === null
          ? event
          : { ...event, error: redact(event.error) };
    }
  };
  return { record, redact, redactValue };
};

export interface TranscriptWriter {
  readonly ref: string;
  append(event: HarnessEvent): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface RawEventsWriter {
  append(event: unknown): void;
  close(): void;
}

export class FileRawEvents implements RawEventsWriter {
  readonly #fd: number;

  private constructor(fd: number) {
    this.#fd = fd;
  }

  static open(dir: string, runId: string): FileRawEvents {
    return new FileRawEvents(openSync(join(dir, rawEventsRef(runId)), 'a'));
  }

  append(event: unknown): void {
    writeSync(this.#fd, `${JSON.stringify(event)}\n`);
  }

  close(): void {
    closeSync(this.#fd);
  }
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
