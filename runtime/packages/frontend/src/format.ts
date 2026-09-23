import type { RunRecord } from '@forge/shared';

export const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;

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

export const totalCost = (runs: RunRecord[]): number =>
  runs.reduce((sum, run) => sum + run.costUsd, 0);
