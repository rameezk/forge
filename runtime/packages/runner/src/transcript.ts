import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';
import { rawEventsRef, requestRecordRef } from '@forge/shared';

const TOOL_PAYLOAD_CAP_CHARS = 32 * 1024;

const REDACTED = '[redacted]';

const capped = (text: string): string =>
  text.length <= TOOL_PAYLOAD_CAP_CHARS
    ? text
    : `${text.slice(0, TOOL_PAYLOAD_CAP_CHARS)}\n[truncated ${text.length - TOOL_PAYLOAD_CAP_CHARS} characters]`;

export interface TranscriptPolicy {
  record(event: HarnessEvent): HarnessEvent;
  redact(text: string): string;
  redactValue<T>(value: T): T;
}

export const transcriptPolicy = (secrets: string[]): TranscriptPolicy => {
  const hidden = secrets.filter((secret) => secret.length > 0);
  const redact = (text: string): string =>
    hidden.reduce(
      (redacted, secret) => redacted.replaceAll(secret, REDACTED),
      text,
    );
  const redactUnknown = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redact(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactUnknown);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          redact(key),
          redactUnknown(field),
        ]),
      );
    }
    return value;
  };
  const redactValue = <T>(value: T): T => redactUnknown(value) as T;

  const record = (event: HarnessEvent): HarnessEvent => {
    switch (event.type) {
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
      default:
        return redactValue(event);
    }
  };
  return { record, redact, redactValue };
};

export interface TranscriptWriter {
  readonly ref: string;
  append(event: HarnessEvent): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface JsonLinesWriter {
  append(value: unknown): void;
  close(): void;
}

export class JsonLinesFile implements TranscriptWriter, JsonLinesWriter {
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

  static requestRecord(dir: string, runId: string): JsonLinesFile {
    return new JsonLinesFile(dir, requestRecordRef(runId));
  }

  append(value: unknown): void {
    writeSync(this.#fd, `${JSON.stringify(value)}\n`);
  }

  close(): void {
    closeSync(this.#fd);
  }
}
