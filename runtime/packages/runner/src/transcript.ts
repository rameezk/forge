import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';
import { rawEventsRef } from '@forge/shared';

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
        return {
          ...event,
          text: redact(event.text),
          ...(event.thinking === undefined ? {} : { thinking: redact(event.thinking) }),
          ...(event.error === undefined ? {} : { error: redact(event.error) }),
        };
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
      case 'compaction':
        return {
          ...event,
          summary: event.summary === null ? null : redact(event.summary),
          error: event.error === null ? null : redact(event.error),
        };
      case 'retry':
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

export class JsonLinesFile implements TranscriptWriter, RawEventsWriter {
  readonly ref: string;
  readonly #fd: number;

  private constructor(dir: string, ref: string) {
    this.ref = ref;
    this.#fd = openSync(join(dir, ref), 'a');
  }

  static transcript(dir: string, runId: string): JsonLinesFile {
    return new JsonLinesFile(dir, `${runId}.jsonl`);
  }

  static rawEvents(dir: string, runId: string): JsonLinesFile {
    return new JsonLinesFile(dir, rawEventsRef(runId));
  }

  append(value: unknown): void {
    writeSync(this.#fd, `${JSON.stringify(value)}\n`);
  }

  close(): void {
    closeSync(this.#fd);
  }
}
