import type { GitIdentity } from './config.ts';

const GITHUB_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; printf \'username=x-access-token\\npassword=%s\\n\' "$GITHUB_TOKEN"; }; f';

const GIT_CONFIG: [string, string][] = [
  ['credential.https://github.com.helper', ''],
  ['credential.https://github.com.helper', GITHUB_CREDENTIAL_HELPER],
];

const gitConfigEnvironment = (
  env: NodeJS.ProcessEnv,
): Record<string, string> => {
  const count = env.GIT_CONFIG_COUNT ?? '';
  if (!/^(0|[1-9][0-9]*)?$/.test(count)) {
    throw new Error(`GIT_CONFIG_COUNT is not a count: '${count}'`);
  }
  const inherited = Number(count);
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(inherited + GIT_CONFIG.length)],
    ...GIT_CONFIG.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${inherited + index}`, key],
      [`GIT_CONFIG_VALUE_${inherited + index}`, value],
    ]),
  ]);
};

export const gitEnvironment = (
  env: NodeJS.ProcessEnv,
  identity: GitIdentity,
): Record<string, string> => ({
  ...gitConfigEnvironment(env),
  GIT_AUTHOR_NAME: identity.name,
  GIT_AUTHOR_EMAIL: identity.email,
  GIT_COMMITTER_NAME: identity.name,
  GIT_COMMITTER_EMAIL: identity.email,
});
