import { DISPATCH_DETAIL_LIMIT } from '../dispatch.ts';
import { STALE_AFTER_MS } from '../heartbeat.ts';

export const boundedDetail = (detail: string | null): string | null =>
  detail === null || detail.length <= DISPATCH_DETAIL_LIMIT
    ? detail
    : `${detail.slice(0, DISPATCH_DETAIL_LIMIT - 1)}…`;

export const liveSince = (now: string): string =>
  new Date(Date.parse(now) - STALE_AFTER_MS).toISOString();
