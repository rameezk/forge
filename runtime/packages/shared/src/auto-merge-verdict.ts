export const GATE_KEYS = [
  'draft',
  'working',
  'mergeability',
  'checks-failing',
  'checks-pending',
  'feedback',
  'protected-path',
  'too-many-files',
  'not-seen',
  'size',
] as const;

export type GateKey = (typeof GATE_KEYS)[number];

export interface FailingGate {
  key: GateKey;
  detail: string;
}

export type AutoMergeVerdict = { kind: 'waits'; gates: FailingGate[] } | { kind: 'auto-merged' };

export type CheckRunConclusion = 'neutral' | 'success';

export interface RecordedAutoMergeVerdict {
  verdict: AutoMergeVerdict;
  conclusion: CheckRunConclusion;
  checkRunId: number;
}
