import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListedModel } from './openrouter.ts';

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

export const piModelsJson = (id: string, model: ListedModel): string => {
  const cost = costOf(model);
  return JSON.stringify({
    providers: {
      openrouter: {
        models: [
          {
            id,
            reasoning: model.reasoning,
            contextWindow: model.contextWindow,
            ...(model.maxOutputTokens === null
              ? {}
              : { maxTokens: model.maxOutputTokens }),
            ...(cost === null ? {} : { cost }),
          },
        ],
      },
    },
  });
};

export type OpenAgentDir = (
  runId: string,
  worker: { model: string },
  listed: ListedModel | null,
) => string;

export const agentDirsIn =
  (root: string): OpenAgentDir =>
  (runId, { model }, listed) => {
    const agentDir = join(root, runId);
    mkdirSync(agentDir, { recursive: true });
    if (listed !== null && listed.contextWindow !== null) {
      writeFileSync(join(agentDir, 'models.json'), piModelsJson(model, listed));
    }
    return agentDir;
  };
