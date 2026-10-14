import type { RunRecord, RunStatus } from '@forge/shared';

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const parseWorkloadFilter = (query: Record<string, string>): WorkloadFilter => {
  const status = STATUSES.find((candidate) => candidate === query['status']);
  const search = (query['search'] ?? '').trim().replace(/^#/, '');
  return {
    ...(status === undefined ? {} : { status }),
    ...(search === '' ? {} : { search }),
    ...(query['worker'] ? { worker: query['worker'] } : {}),
    ...(query['repository'] ? { repository: query['repository'] } : {}),
    ...(query['model'] ? { model: query['model'] } : {}),
    ...(DATE.test(query['from'] ?? '') ? { from: query['from']! } : {}),
    ...(DATE.test(query['to'] ?? '') ? { to: query['to']! } : {}),
  };
};

const matchesSearch = (run: RunRecord, search: string): boolean => {
  const needle = search.toLowerCase();
  return run.worker.toLowerCase().includes(needle) || String(run.ticket?.number ?? '') === search;
};

export const filterWorkloads = (
  runs: RunRecord[],
  filter: WorkloadFilter,
  ignoreStatus = false,
): RunRecord[] =>
  runs.filter(
    (run) =>
      (ignoreStatus || filter.status === undefined || run.status === filter.status) &&
      (filter.search === undefined || matchesSearch(run, filter.search)) &&
      (filter.worker === undefined || run.worker === filter.worker) &&
      (filter.repository === undefined || run.ticket?.repository === filter.repository) &&
      (filter.model === undefined || run.model === filter.model) &&
      (filter.from === undefined || run.startTime.slice(0, 10) >= filter.from) &&
      (filter.to === undefined || run.startTime.slice(0, 10) <= filter.to),
  );

export const isFiltered = (filter: WorkloadFilter): boolean => Object.keys(filter).length > 0;

export const workloadsHref = (filter: WorkloadFilter): string => {
  const query = new URLSearchParams(Object.entries(filter) as [string, string][]).toString();
  return query === '' ? '/' : `/?${query}`;
};
