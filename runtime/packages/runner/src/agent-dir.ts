import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListedModel } from './openrouter.ts';
import { PI_PROVIDER } from './provider.ts';

const PER_MILLION = 1_000_000;

const perMillionTokens = (perToken: number | null): number | null =>
  perToken === null ? null : Number((perToken * PER_MILLION).toPrecision(12));

const costOf = ({ price }: ListedModel): Record<string, number> | null => {
  const cost = {
    input: perMillionTokens(price.input),
    output: perMillionTokens(price.output),
    cacheRead: perMillionTokens(price.cacheRead) ?? 0,
    cacheWrite: perMillionTokens(price.cacheWrite) ?? 0,
  };
  return Object.values(cost).every((value) => Number.isFinite(value))
    ? (cost as Record<string, number>)
    : null;
};

const CHAT_COMPLETIONS_API = 'openai-completions';

const listedDetails = (model: ListedModel | null): Record<string, unknown> => {
  if (model === null || model.contextWindow === null) {
    return {};
  }
  const cost = costOf(model);
  return {
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    ...(model.maxOutputTokens === null
      ? {}
      : { maxTokens: model.maxOutputTokens }),
    ...(cost === null ? {} : { cost }),
  };
};

export const piModelsJson = (id: string, model: ListedModel | null): string =>
  JSON.stringify({
    providers: {
      [PI_PROVIDER]: {
        models: [{ id, api: CHAT_COMPLETIONS_API, ...listedDetails(model) }],
      },
    },
  });

export type OpenAgentDir = (
  runId: string,
  model: string,
  listed: ListedModel | null,
) => string;

export const agentDirsIn =
  (root: string): OpenAgentDir =>
  (runId, model, listed) => {
    const agentDir = join(root, runId);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'models.json'), piModelsJson(model, listed), {
      mode: 0o444,
    });
    chmodSync(agentDir, 0o555);
    return agentDir;
  };
