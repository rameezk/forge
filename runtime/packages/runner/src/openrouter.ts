import type { Billing, NativeUsage } from '@forge/shared';
import { tokenCount } from './token-count.ts';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

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
      const url = new URL(`${baseUrl.href.replace(/\/$/, '')}/generation`);
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
