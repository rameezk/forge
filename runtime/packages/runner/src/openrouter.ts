import type { Billing, ListPrice, NativeUsage } from '@forge/shared';
import { tokenCount } from './token-count.ts';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

export const openRouterBaseUrl = (env: NodeJS.ProcessEnv): URL => {
  const baseUrl = env.OPENROUTER_BASE_URL ?? OPENROUTER_API;
  const url = URL.parse(baseUrl);
  if (url === null || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error(
      `OPENROUTER_BASE_URL is not an http(s) URL: ${JSON.stringify(baseUrl)}`,
    );
  }
  return url;
};

const endpoint = (baseUrl: URL, path: string): URL =>
  new URL(`${baseUrl.href.replace(/\/$/, '')}/${path}`);

const NOT_FOUND = 404;

const TOO_MANY_REQUESTS = 429;

const LOOKUP_TIMEOUT_MS = 5000;

const isTemporaryStatus = (status: number): boolean =>
  status === NOT_FOUND || status === TOO_MANY_REQUESTS || status >= 500;

const isNetworkFailure = (error: unknown): boolean =>
  (error instanceof TypeError && error.cause !== undefined) ||
  (error instanceof DOMException && error.name === 'TimeoutError');

const failureOf = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'lookup failed';
  }
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
};

export type LookupOutcome =
  | { outcome: 'billed'; billing: Billing }
  | { outcome: 'temporary' | 'permanent'; reason: string };

export type LookUpGeneration = (generationId: string) => Promise<LookupOutcome>;

interface GenerationData {
  total_cost?: unknown;
  native_tokens_prompt?: unknown;
  native_tokens_cached?: unknown;
  native_tokens_completion?: unknown;
  native_tokens_reasoning?: unknown;
  provider_name?: unknown;
}

const usageOf = (data: GenerationData): NativeUsage | null => {
  const promptTokens = tokenCount(data.native_tokens_prompt);
  const cacheReadTokens = tokenCount(data.native_tokens_cached);
  const outputTokens = tokenCount(data.native_tokens_completion);
  return promptTokens === null || cacheReadTokens === null || outputTokens === null
    ? null
    : { promptTokens, cacheReadTokens, outputTokens };
};

const billingOf = (data: GenerationData, costUsd: number): Billing => ({
  costUsd,
  usage: usageOf(data),
  reasoningTokens: tokenCount(data.native_tokens_reasoning),
  provider:
    typeof data.provider_name === 'string' && data.provider_name !== ''
      ? data.provider_name
      : null,
});

export const openRouterLookUp =
  (baseUrl: URL, apiKey: string): LookUpGeneration =>
  async (generationId) => {
    try {
      const url = endpoint(baseUrl, 'generation');
      url.searchParams.set('id', generationId);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          outcome: isTemporaryStatus(response.status) ? 'temporary' : 'permanent',
          reason: `HTTP ${response.status}`,
        };
      }
      const data =
        ((await response.json()) as { data?: GenerationData } | null)?.data ?? {};
      const cost = data.total_cost;
      return typeof cost === 'number' && Number.isFinite(cost)
        ? { outcome: 'billed', billing: billingOf(data, cost) }
        : { outcome: 'permanent', reason: 'response has no numeric total_cost' };
    } catch (error) {
      return {
        outcome: isNetworkFailure(error) ? 'temporary' : 'permanent',
        reason: failureOf(error),
      };
    }
  };

export type ListPriceOutcome = { price: ListPrice } | { reason: string };

export type LookUpListPrice = (model: string) => Promise<ListPriceOutcome>;

interface ModelData {
  id?: unknown;
  pricing?: Record<string, unknown>;
}

const perToken = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
};

const listPriceOf = (pricing: Record<string, unknown>): ListPrice | null => {
  const input = perToken(pricing.prompt);
  const output = perToken(pricing.completion);
  return input === null || output === null
    ? null
    : {
        input,
        output,
        cacheRead: perToken(pricing.input_cache_read),
        cacheWrite: perToken(pricing.input_cache_write),
      };
};

export const openRouterListPrice =
  (baseUrl: URL): LookUpListPrice =>
  async (model) => {
    try {
      const response = await fetch(endpoint(baseUrl, 'models'), {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { reason: `HTTP ${response.status}` };
      }
      const body = (await response.json()) as { data?: unknown } | null;
      const models = Array.isArray(body?.data) ? (body.data as ModelData[]) : [];
      const listed = models.find((entry) => entry?.id === model);
      if (listed === undefined) {
        return { reason: 'the model is not listed' };
      }
      const price = listPriceOf(listed.pricing ?? {});
      return price === null
        ? { reason: 'the model has no prompt and completion price' }
        : { price };
    } catch (error) {
      return { reason: failureOf(error) };
    }
  };
