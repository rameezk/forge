import { readFileSync } from 'node:fs';
import { isHeaderValue } from './http.ts';

const readTokenFile = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
};

const unquoted = (value: string): string =>
  /^(["'])(.*)\1$/s.exec(value)?.[2] ?? value;

export const githubWriteToken = (env: NodeJS.ProcessEnv): string => {
  const path = env.FORGE_GITHUB_WRITE_TOKEN_FILE;
  if (path === undefined) {
    throw new Error('FORGE_GITHUB_WRITE_TOKEN_FILE is not set');
  }
  const token =
    readTokenFile(path)
      .split(/\r?\n/)
      .flatMap((line) => {
        const equals = line.indexOf('=');
        return equals !== -1 && line.slice(0, equals).trim() === 'GITHUB_TOKEN'
          ? [unquoted(line.slice(equals + 1).trim())]
          : [];
      })
      .at(-1) ?? '';
  if (token === '') throw new Error('GitHub write token missing');
  if (!isHeaderValue(token)) throw new Error('GitHub write token malformed');
  return token;
};
