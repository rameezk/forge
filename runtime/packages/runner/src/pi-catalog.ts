import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ListedModel, LookUpModel } from './openrouter.ts';

const PER_MILLION = 1_000_000;

const CATALOG_MODULE = join(
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'providers',
  'anthropic.models.js',
);

interface CatalogEntry {
  cost?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
  };
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
}

const perToken = (perMillion: unknown): number | null =>
  typeof perMillion === 'number' && Number.isFinite(perMillion) && perMillion >= 0
    ? perMillion / PER_MILLION
    : null;

const limitOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

export const piCatalogModel =
  (piPackage: string): LookUpModel =>
  async (model) => {
    let catalog: Record<string, CatalogEntry>;
    try {
      const loaded = (await import(
        pathToFileURL(join(piPackage, CATALOG_MODULE)).href
      )) as { ANTHROPIC_MODELS: Record<string, CatalogEntry> };
      catalog = loaded.ANTHROPIC_MODELS;
    } catch (error) {
      return {
        reason: `pi's model catalog could not be read (${error instanceof Error ? error.name : 'unreadable'})`,
      };
    }
    const entry = Object.hasOwn(catalog, model) ? catalog[model] : undefined;
    if (entry === undefined) {
      return { reason: "the model is not in pi's catalog" };
    }
    const input = perToken(entry.cost?.input);
    const output = perToken(entry.cost?.output);
    if (input === null || output === null) {
      return { reason: "pi's catalog has no input and output price for the model" };
    }
    const listed: ListedModel = {
      price: {
        input,
        output,
        cacheRead: perToken(entry.cost?.cacheRead),
        cacheWrite: perToken(entry.cost?.cacheWrite),
      },
      contextWindow: limitOf(entry.contextWindow),
      maxOutputTokens: limitOf(entry.maxTokens),
      reasoning: entry.reasoning === true,
    };
    return { model: listed };
  };
