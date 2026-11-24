import { STALE_AFTER_MS } from '../heartbeat.ts';

export const liveSince = (now: string): string =>
  new Date(Date.parse(now) - STALE_AFTER_MS).toISOString();
