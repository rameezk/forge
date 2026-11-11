import type { HarnessEvent, SignalDeath as SignalDeathRecord } from '@forge/shared';
import { SignalDeath } from './sandbox.ts';

export interface InFlightCall {
  id: string;
  name: string;
}

export class InFlightCalls {
  readonly #open = new Map<string, string>();

  observe(event: HarnessEvent): void {
    if (event.type === 'tool_call') {
      this.#open.set(event.id, event.name);
    } else if (event.type === 'tool_result') {
      this.#open.delete(event.id);
    }
  }

  latest(): InFlightCall | null {
    const last = [...this.#open].at(-1);
    return last === undefined ? null : { id: last[0], name: last[1] };
  }
}

export interface SignalDeathReport {
  error: string;
  signalDeath: SignalDeathRecord;
}

export const signalDeathReport = (
  failure: Error | null,
  calls: InFlightCalls,
): SignalDeathReport | null => {
  if (!(failure instanceof SignalDeath)) return null;
  const call = calls.latest();
  const where = call === null ? '' : ` while tool call ${call.id} (${call.name}) was in flight`;
  const reason = failure.reason === '' ? '' : `: ${failure.reason}`;
  return {
    error: `${failure.harness} was killed by ${failure.signal}${where}${reason}`,
    signalDeath: { signal: failure.signal, toolCallId: call?.id ?? null },
  };
};

export const signalDeathField = (
  death: SignalDeathReport | null,
  error: string | null,
): { signalDeath?: SignalDeathRecord } =>
  death !== null && error === death.error ? { signalDeath: death.signalDeath } : {};
