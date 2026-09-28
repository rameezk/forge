import { setTimeout as sleep } from 'node:timers/promises';
import type { RunCost } from './harness.ts';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

const LAG_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

const NOT_FOUND = 404;

const LOOKUP_TIMEOUT_MS = 5000;

type Lookup = number | 'lagging' | 'failed';

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
    const billed = await Promise.all(
      generationIds.map((id) => this.#billed(id)),
    );
    const known = billed.filter((cost) => cost !== null);
    return {
      costUsd: known.reduce((sum, cost) => sum + cost, 0),
      uncertain: known.length < billed.length,
    };
  }

  async #billed(id: string): Promise<number | null> {
    for (const delay of [0, ...LAG_RETRY_DELAYS_MS]) {
      await sleep(delay);
      const lookup = await this.#lookup(id);
      if (typeof lookup === 'number') {
        return lookup;
      }
      if (lookup === 'failed') {
        return null;
      }
    }
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
        return response.status === NOT_FOUND ? 'lagging' : 'failed';
      }
      const cost = ((await response.json()) as GenerationResponse).data
        ?.total_cost;
      return typeof cost === 'number' && Number.isFinite(cost)
        ? cost
        : 'failed';
    } catch {
      return 'failed';
    }
  }
}
