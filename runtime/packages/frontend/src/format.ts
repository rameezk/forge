import type { RunRecord } from '@forge/shared';

export const formatCost = (usd: number): string => `$${usd.toFixed(6)}`;

export const formatSpend = (usd: number): string => `$${usd.toFixed(2)}`;

export const formatBudget = (usd: number): string => {
  if (Number.isInteger(usd)) return `$${usd}`;
  const [whole, fraction = ''] = usd.toFixed(6).replace(/0+$/, '').split('.');
  return `$${whole}.${fraction.padEnd(2, '0')}`;
};

export const formatTotal = (usd: number): string => `$${usd.toFixed(4)}`;

const formatters = new Map<string, Intl.DateTimeFormat>();

export const partsIn = (time: number, timeZone: string): Record<string, string> => {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(time).map(({ type, value }) => [type, value]));
};

export const formatDate = (iso: string, timeZone: string): string => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const { year, month, day } = partsIn(time, timeZone);
  return `${year}-${month}-${day}`;
};

export const formatTime = (iso: string, timeZone: string): string => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const { hour, minute, second } = partsIn(time, timeZone);
  return `${hour}:${minute}:${second}`;
};

export const formatStarted = (iso: string, timeZone: string): string =>
  Number.isNaN(Date.parse(iso)) ? iso : `${formatDate(iso, timeZone)} ${formatTime(iso, timeZone)}`;

const tokenCount = new Intl.NumberFormat('en-US');

export const formatTokens = (count: number): string => tokenCount.format(count);

const percentage = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const cacheHitRate = (
  run: Pick<RunRecord, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
): string | null => {
  if (run.cacheReadTokens === null || run.cacheWriteTokens === null) {
    return null;
  }
  const promptTokens = run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens;
  return promptTokens === 0 ? 'n/a' : percentage.format(run.cacheReadTokens / promptTokens);
};

export const formatElapsed = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

export const formatSpan = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    hours === 0 && rest > 0 ? `${rest}s` : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? '0s' : parts.join(' ');
};

export const formatDuration = (
  startTime: string,
  endTime: string | null,
): string =>
  endTime === null ? 'running' : formatElapsed(Date.parse(endTime) - Date.parse(startTime));

const isPending = (run: RunRecord): boolean => run.costStatus === 'pending';

export const isSubscription = (run: Pick<RunRecord, 'costStatus'>): boolean =>
  run.costStatus === 'subscription';

export const totalCost = (runs: RunRecord[]): number =>
  runs.filter((run) => !isSubscription(run)).reduce((sum, run) => sum + run.costUsd, 0);

export const totalUnconfirmedEstimate = (runs: RunRecord[]): number =>
  runs.filter((run) => !isSubscription(run)).reduce((sum, run) => sum + run.unconfirmedEstimateUsd, 0);

export const pendingCount = (runs: RunRecord[]): number =>
  runs.filter(isPending).length;

export const formatRate = (rate: number | null): string =>
  rate === null ? 'n/a' : percentage.format(rate);

const measure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export const formatMeasure = (value: number | null): string =>
  value === null ? 'n/a' : measure.format(value);
