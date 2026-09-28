import { setTimeout as sleep } from 'node:timers/promises';
import type { RunCost } from './harness.ts';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

const NOT_FOUND = 404;

const TOO_MANY_REQUESTS = 429;

const isTransient = (status: number): boolean =>
  status === NOT_FOUND || status === TOO_MANY_REQUESTS || status >= 500;

const LOOKUP_TIMEOUT_MS = 5000;

const CONCURRENT_LOOKUPS = 4;

type Lookup = number | { transient: boolean; reason: string };

export interface Billing {
  cost(generationIds: string[]): Promise<RunCost>;
}

export interface OpenRouterBillingOptions {
  baseUrl: string;
  apiKey: string;
}

interface GenerationResponse {
  data?: { total_cost?: unknown };
}

export class OpenRouterBilling implements Billing {
  readonly #baseUrl: string;
  readonly #apiKey: string;

  constructor(options: OpenRouterBillingOptions) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
  }

  async cost(generationIds: string[]): Promise<RunCost> {
    const ids = [...new Set(generationIds)];
    const billed: (number | null)[] = [];
    let next = 0;
    const lookUpRemaining = async (): Promise<void> => {
      for (let index = next++; index < ids.length; index = next++) {
        billed[index] = await this.#billed(ids[index] as string);
      }
    };
    await Promise.all(
      Array.from({ length: CONCURRENT_LOOKUPS }, lookUpRemaining),
    );
    const known = billed.filter((cost) => cost !== null);
    return {
      costUsd: known.reduce((sum, cost) => sum + cost, 0),
      uncertain: known.length < billed.length,
    };
  }

  async #billed(id: string): Promise<number | null> {
    let reason = '';
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      await sleep(delay);
      const lookup = await this.#lookup(id);
      if (typeof lookup === 'number') {
        return lookup;
      }
      reason = lookup.reason;
      if (!lookup.transient) {
        break;
      }
    }
    process.stderr.write(
      `could not cost OpenRouter generation ${JSON.stringify(id)}: ${reason}\n`,
    );
    return null;
  }

  async #lookup(id: string): Promise<Lookup> {
    try {
      const url = new URL(`${this.#baseUrl}/generation`);
      url.searchParams.set('id', id);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          transient: isTransient(response.status),
          reason: `HTTP ${response.status}`,
        };
      }
      const cost = ((await response.json()) as GenerationResponse).data
        ?.total_cost;
      return typeof cost === 'number' && Number.isFinite(cost)
        ? cost
        : { transient: false, reason: 'response has no numeric total_cost' };
    } catch (error) {
      return {
        transient: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
