export const SAMPLE_RATE = 0.25;

export const PAUSE_WINDOW = 20;

export const PAUSE_BAR_PERCENT = 90;

export const WARM_UP_SETTLED = 10;

export const AUTO_MERGE_STATES = ['live', 'warming-up', 'paused'] as const;

export type AutoMergeState = (typeof AUTO_MERGE_STATES)[number];

export interface AutoMergeStatus {
  state: AutoMergeState;
  settled: number;
  heldUp: number;
  judged: number;
}

export interface AutoMergeCounts {
  autoMerged: number;
  sampled: number;
}

export const autoMergeStateOf = ({ settled, heldUp, judged }: Omit<AutoMergeStatus, 'state'>): AutoMergeState => {
  if (settled < WARM_UP_SETTLED || judged === 0) return 'warming-up';
  return heldUp * 100 < judged * PAUSE_BAR_PERCENT ? 'paused' : 'live';
};

export const sampleRateIn = (state: AutoMergeState): number => (state === 'live' ? SAMPLE_RATE : 1);
