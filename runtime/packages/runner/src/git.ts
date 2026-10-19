import type { BotIdentity } from '@forge/shared';
import { GITHUB_TOKEN_FILE_ENV } from './github-token-file.ts';

const GITHUB_CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; token="$(cat "$${GITHUB_TOKEN_FILE_ENV}")" || exit 1; printf 'username=x-access-token\\npassword=%s\\n' "$token"; }; f`;

const GIT_CONFIG: [string, string][] = [
  ['credential.https://github.com.helper', ''],
  ['credential.https://github.com.helper', GITHUB_CREDENTIAL_HELPER],
];

const ZDIFF3_CONFIG: [string, string] = ['merge.conflictStyle', 'zdiff3'];

const gitConfigEnvironment = (
  env: NodeJS.ProcessEnv,
  settings: [string, string][],
): Record<string, string> => {
  const count = env.GIT_CONFIG_COUNT ?? '';
  if (!/^(0|[1-9][0-9]*)?$/.test(count)) {
    throw new Error(`GIT_CONFIG_COUNT is not a count: '${count}'`);
  }
  const inherited = Number(count);
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(inherited + settings.length)],
    ...settings.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${inherited + index}`, key],
      [`GIT_CONFIG_VALUE_${inherited + index}`, value],
    ]),
  ]);
};

export const gitEnvironment = (
  env: NodeJS.ProcessEnv,
  identity: BotIdentity,
  { conflictResolution = false }: { conflictResolution?: boolean } = {},
): Record<string, string> => ({
  ...gitConfigEnvironment(
    env,
    conflictResolution ? [...GIT_CONFIG, ZDIFF3_CONFIG] : GIT_CONFIG,
  ),
  GIT_AUTHOR_NAME: identity.name,
  GIT_AUTHOR_EMAIL: identity.email,
  GIT_COMMITTER_NAME: identity.name,
  GIT_COMMITTER_EMAIL: identity.email,
});
