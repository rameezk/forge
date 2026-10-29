import type { DispatchState, RunRecord } from '@forge/shared';
import { addDays, dayOf, dayRange, parseDay } from './days.ts';

export const STATUSES: readonly DispatchState[] = ['running', 'done', 'failed'];

export interface RangePreset {
  key: string;
  label: string;
  resolve: (today: string) => { from: string; to: string };
}

const lastDays = (count: number) => (today: string) => ({ from: addDays(today, 1 - count), to: today });

export const RANGE_PRESETS: readonly RangePreset[] = [
  { key: 'today', label: 'Today', resolve: lastDays(1) },
  { key: 'yesterday', label: 'Yesterday', resolve: (today) => ({ from: addDays(today, -1), to: addDays(today, -1) }) },
  { key: '7d', label: 'Last 7 days', resolve: lastDays(7) },
  { key: '30d', label: 'Last 30 days', resolve: lastDays(30) },
  { key: 'month', label: 'This month', resolve: (today) => ({ from: `${today.slice(0, 8)}01`, to: today }) },
];

export interface WorkloadFilter {
  range?: string;
  status?: DispatchState;
  search?: string;
  worker?: string;
  repository?: string;
  model?: string;
  from?: string;
  to?: string;
}

export const parseWorkloadFilter = (query: Record<string, string>): WorkloadFilter => {
  const status = STATUSES.find((candidate) => candidate === query['status']);
  const range = RANGE_PRESETS.find((candidate) => candidate.key === query['range'])?.key;
  const from = range === undefined ? parseDay(query['from']) : undefined;
  const to = range === undefined ? parseDay(query['to']) : undefined;
  const search = (query['search'] ?? '').trim().replace(/^#/, '');
  return {
    ...(status === undefined ? {} : { status }),
    ...(search === '' ? {} : { search }),
    ...(query['worker'] ? { worker: query['worker'] } : {}),
    ...(query['repository'] ? { repository: query['repository'] } : {}),
    ...(query['model'] ? { model: query['model'] } : {}),
    ...(range === undefined ? {} : { range }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
};

const matchesSearch = (run: RunRecord, search: string): boolean => {
  const needle = search.toLowerCase();
  return run.worker.toLowerCase().includes(needle) || String(run.ticket?.number ?? '') === search;
};

export const filterWorkloads = (
  runs: RunRecord[],
  filter: WorkloadFilter,
  timeZone: string,
  now: number,
  stateOf: (run: RunRecord) => DispatchState,
  ignoreStatus = false,
): RunRecord[] => {
  const preset = RANGE_PRESETS.find(({ key }) => key === filter.range);
  const days = preset === undefined ? filter : preset.resolve(dayOf(now, timeZone));
  const { startedFrom, startedBefore } = dayRange(days.from, days.to, timeZone);
  return runs.filter(
    (run) =>
      (ignoreStatus || filter.status === undefined || stateOf(run) === filter.status) &&
      (filter.search === undefined || matchesSearch(run, filter.search)) &&
      (filter.worker === undefined || run.worker === filter.worker) &&
      (filter.repository === undefined || run.ticket?.repository === filter.repository) &&
      (filter.model === undefined || run.model === filter.model) &&
      (startedFrom === undefined || Date.parse(run.startTime) >= startedFrom) &&
      (startedBefore === undefined || Date.parse(run.startTime) < startedBefore),
  );
};

export const isFiltered = (filter: WorkloadFilter): boolean => Object.keys(filter).length > 0;

export const PAGE_SIZE = 50;

export const parsePage = (query: Record<string, string>): number => {
  const page = Number(query['page']);
  return Number.isInteger(page) && page > 1 ? page : 1;
};

export interface Page<T> {
  items: T[];
  page: number;
  hasNewer: boolean;
  hasOlder: boolean;
}

export const paginate = <T>(items: T[], requested: number): Page<T> => {
  const last = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(requested, last);
  return {
    items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    hasNewer: page > 1,
    hasOlder: page < last,
  };
};

export const workloadsHref = (filter: WorkloadFilter, page = 1): string => {
  const entries = Object.entries(filter) as [string, string][];
  const query = new URLSearchParams(page > 1 ? [...entries, ['page', String(page)]] : entries).toString();
  return query === '' ? '/workloads' : `/workloads?${query}`;
};
