import { DatabaseSync } from 'node:sqlite';
import type { RunRecord } from '../../src/index.ts';

export const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 3100,
  cacheWriteTokens: 600,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ticket: null,
  aliveAt: '2026-09-21T10:03:00.000Z',
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

export const columnsOf = (path: string, table: string): string[] => {
  const raw = new DatabaseSync(path);
  const columns = (raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
    ({ name }) => name,
  );
  raw.close();
  return columns;
};

