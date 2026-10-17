import type { RunRecord, RunStatus } from '@forge/shared';
import { dayRange, parseDay } from './days.ts';

export const STATUSES: readonly RunStatus[] = ['running', 'success', 'error', 'interrupted', 'exceeded'];

export interface WorkloadFilter {
  status?: RunStatus;
  search?: string;
  worker?: string;
  repository?: string;
  model?: string;
  from?: string;
  to?: string;
}

export const parseWorkloadFilter = (query: Record<string, string>): WorkloadFilter => {
  const status = STATUSES.find((candidate) => candidate === query['status']);
  const from = parseDay(query['from']);
  const to = parseDay(query['to']);
  const search = (query['search'] ?? '').trim().replace(/^#/, '');
  return {
    ...(status === undefined ? {} : { status }),
    ...(search === '' ? {} : { search }),
    ...(query['worker'] ? { worker: query['worker'] } : {}),
    ...(query['repository'] ? { repository: query['repository'] } : {}),
    ...(query['model'] ? { model: query['model'] } : {}),
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
  ignoreStatus = false,
): RunRecord[] => {
  const { startedFrom, startedBefore } = dayRange(filter.from, filter.to, timeZone);
  return runs.filter(
    (run) =>
      (ignoreStatus || filter.status === undefined || run.status === filter.status) &&
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
  return query === '' ? '/runs' : `/runs?${query}`;
};
