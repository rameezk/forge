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

export const GATE_LABELS: Record<GateKey, string> = {
  draft: 'draft',
  working: 'working',
  mergeability: 'mergeability',
  'checks-failing': 'checks failing',
  'checks-pending': 'checks pending',
  feedback: 'feedback',
  'protected-path': 'protected path',
  'too-many-files': 'too many files',
  'not-seen': 'not seen by Jev',
  size: 'size',
};

export interface FailingGate {
  key: GateKey;
  detail: string;
}

export type AutoMergeVerdict =
  | { kind: 'waits'; gates: FailingGate[] }
  | { kind: 'held' }
  | { kind: 'sampled'; reason: string }
  | { kind: 'merges-nothing'; failures: string[] }
  | { kind: 'auto-merged' };

export type CheckRunConclusion = 'neutral' | 'success';

export interface RecordedAutoMergeVerdict {
  verdict: AutoMergeVerdict;
  conclusion: CheckRunConclusion;
  checkRunId: number;
}
