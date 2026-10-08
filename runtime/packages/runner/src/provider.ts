import PROVIDERS from './providers.json' with { type: 'json' };

export type Provider = 'openrouter' | 'anthropic';

export const ALLOWED_PROVIDERS: readonly string[] = PROVIDERS;

export const DEFAULT_PROVIDER: Provider = 'openrouter';

export interface ProviderSpec {
  piName: string;
  credentialEnv: string;
  subscription: boolean;
}

const SPECS: Record<Provider, ProviderSpec> = {
  openrouter: {
    piName: 'openrouter',
    credentialEnv: 'OPENROUTER_API_KEY',
    subscription: false,
  },
  anthropic: {
    piName: 'anthropic',
    credentialEnv: 'ANTHROPIC_OAUTH_TOKEN',
    subscription: true,
  },
};

export const isProvider = (value: string): value is Provider =>
  ALLOWED_PROVIDERS.includes(value);

export const providerSpec = (provider: Provider): ProviderSpec =>
  SPECS[provider];

export const withoutCredentials = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const kept = { ...env };
  for (const { credentialEnv } of Object.values(SPECS)) {
    delete kept[credentialEnv];
  }
  return kept;
};
