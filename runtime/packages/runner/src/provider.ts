import PROVIDERS from './providers.json' with { type: 'json' };

export type Provider = 'openrouter';

export const ALLOWED_PROVIDERS: readonly string[] = PROVIDERS;

export const DEFAULT_PROVIDER: Provider = 'openrouter';

export interface ProviderSpec {
  piName: string;
  credentialEnv: string;
}

const SPECS: Record<Provider, ProviderSpec> = {
  openrouter: { piName: 'openrouter', credentialEnv: 'OPENROUTER_API_KEY' },
};

export const isProvider = (value: string): value is Provider =>
  ALLOWED_PROVIDERS.includes(value);

export const providerSpec = (provider: Provider): ProviderSpec =>
  SPECS[provider];
