import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'github-app');

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>;

export const APP_ID = '5313638';
export const INSTALLED = 'rameezk/forge-app-test';

export interface Mint {
  installation: string;
  body: { repositories?: string[]; permissions?: Record<string, string> };
  jwt: string;
}

export interface FakeGithubApp {
  fetch: typeof globalThis.fetch;
  privateKey: string;
  mints: Mint[];
  now: { value: number };
}

const base64url = (value: string): Buffer => Buffer.from(value, 'base64url');

const jwtClaims = (
  jwt: string,
  publicKey: KeyObject,
): { iss: string; iat: number; exp: number } | null => {
  const [header, payload, signature] = jwt.split('.');
  if (header === undefined || payload === undefined || signature === undefined) return null;
  const verified = createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, base64url(signature));
  if (!verified) return null;
  return JSON.parse(base64url(payload).toString('utf8')) as {
    iss: string;
    iat: number;
    exp: number;
  };
};

export const fakeGithubApp = (installed: string[] = [INSTALLED]): FakeGithubApp => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mints: Mint[] = [];
  const now = { value: Date.parse('2026-10-14T10:00:00Z') };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const jwt = authorization.replace(/^Bearer /, '');
    const claims = jwtClaims(jwt, publicKey);
    const seconds = now.value / 1000;
    if (
      claims === null ||
      claims.iss !== APP_ID ||
      claims.iat > seconds ||
      claims.exp <= seconds ||
      claims.exp - claims.iat > 600
    ) {
      return json({ message: 'A JSON web token could not be decoded' }, 401);
    }
    const installationOf = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname);
    if (installationOf !== null) {
      return installed.includes(installationOf[1] ?? '')
        ? json(fixture('installation'))
        : json(fixture('installation-not-found'), 404);
    }
    const mintFor = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mintFor !== null && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Mint['body'];
      mints.push({ installation: mintFor[1] ?? '', body, jwt });
      const minted = fixture('token');
      return json(
        {
          ...minted,
          token: `ghs_minted${mints.length}`,
          expires_at: new Date(now.value + 3600_000).toISOString().replace('.000Z', 'Z'),
        },
        201,
      );
    }
    return json({ message: 'Not Found' }, 404);
  };
  return {
    fetch,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    mints,
    now,
  };
};
