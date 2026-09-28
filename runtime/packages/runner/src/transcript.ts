import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';
import { transcriptLine } from '@forge/shared';

const TOOL_PAYLOAD_CAP_CHARS = 32 * 1024;

const REDACTED = '[redacted]';

const capped = (text: string): string =>
  text.length <= TOOL_PAYLOAD_CAP_CHARS
    ? text
    : `${text.slice(0, TOOL_PAYLOAD_CAP_CHARS)}\n[truncated ${text.length - TOOL_PAYLOAD_CAP_CHARS} characters]`;

export const recordable = (
  secrets: string[],
): ((event: HarnessEvent) => HarnessEvent) => {
  const hidden = secrets.filter((secret) => secret.length > 0);
  const redact = (text: string, form: (secret: string) => string): string =>
    hidden.reduce(
      (redacted, secret) => redacted.replaceAll(form(secret), REDACTED),
      text,
    );
  const asText = (secret: string): string => secret;
  const inJson = (secret: string): string =>
    JSON.stringify(secret).slice(1, -1);
  return (event) => {
    switch (event.type) {
      case 'message':
        return { ...event, text: redact(event.text, asText) };
      case 'tool_call': {
        const json = redact(JSON.stringify(event.arguments), inJson);
        return {
          ...event,
          arguments:
            json.length <= TOOL_PAYLOAD_CAP_CHARS
              ? (JSON.parse(json) as unknown)
              : capped(json),
        };
      }
      case 'tool_result':
        return { ...event, text: capped(redact(event.text, asText)) };
      case 'result':
        return event;
    }
  };
};

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
