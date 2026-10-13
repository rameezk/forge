import type { LookUpModel } from './openrouter.ts';

const MODERN = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

const LEGACY = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/;

const version = (major: string, minor: string | undefined): string =>
  minor === undefined ? major : `${major}.${minor}`;

export const openRouterIdOf = (model: string): string | null => {
  const modern = MODERN.exec(model);
  if (modern !== null) {
    const [, family = '', major = '', minor] = modern;
    return `anthropic/claude-${family}-${version(major, minor)}`;
  }
  const legacy = LEGACY.exec(model);
  if (legacy !== null) {
    const [, major = '', minor, family = ''] = legacy;
    return `anthropic/claude-${version(major, minor)}-${family}`;
  }
  return null;
};

export const anthropicModel =
  (lookUp: LookUpModel): LookUpModel =>
  async (model) => {
    const mapped = openRouterIdOf(model);
    if (mapped === null) {
      return { reason: `${model} has no OpenRouter mapping` };
    }
    return lookUp(mapped);
  };
