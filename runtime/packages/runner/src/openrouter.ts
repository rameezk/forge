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
  | { outcome: 'billed'; costUsd: number }
  | { outcome: 'temporary' | 'permanent'; reason: string };

export type LookUpGeneration = (generationId: string) => Promise<LookupOutcome>;

interface GenerationResponse {
  data?: { total_cost?: unknown };
}

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
      const cost = ((await response.json()) as GenerationResponse).data
        ?.total_cost;
      return typeof cost === 'number' && Number.isFinite(cost)
        ? { outcome: 'billed', costUsd: cost }
        : { outcome: 'permanent', reason: 'response has no numeric total_cost' };
    } catch (error) {
      return {
        outcome: isNetworkFailure(error) ? 'temporary' : 'permanent',
        reason: failureOf(error),
      };
    }
  };
