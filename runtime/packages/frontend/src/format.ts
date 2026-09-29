import type { RunRecord } from '@forge/shared';

export const formatCost = (usd: number): string => `$${usd.toFixed(6)}`;

export const formatTotal = (usd: number): string => `$${usd.toFixed(4)}`;

export const formatStarted = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time)
    ? iso
    : `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

export const formatDate = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toISOString().slice(0, 10);
};

const tokenCount = new Intl.NumberFormat('en-US');

export const formatTokens = (count: number): string => tokenCount.format(count);

export const formatDuration = (
  startTime: string,
  endTime: string | null,
): string => {
  if (endTime === null) return 'running';
  const totalSeconds = Math.max(
    0,
    Math.round((Date.parse(endTime) - Date.parse(startTime)) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

const isPending = (run: RunRecord): boolean => run.costStatus === 'pending';

export const settledCost = (runs: RunRecord[]): number =>
  runs
    .filter((run) => !isPending(run))
    .reduce((sum, run) => sum + run.costUsd, 0);

export const pendingCount = (runs: RunRecord[]): number =>
  runs.filter(isPending).length;
