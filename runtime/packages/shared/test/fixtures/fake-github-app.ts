import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'github-app');

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Record<string, unknown>;

export const APP_ID = '5313638';
export const APP_SLUG = 'forge-test-rameezk';
export const BOT_USER_ID = 171311378;
export const BOT_LOGIN = `${APP_SLUG}[bot]`;
export const BOT_EMAIL = `${BOT_USER_ID}+${BOT_LOGIN}@users.noreply.github.com`;
export const INSTALLED = 'rameezk/forge-app-test';
const INSTALLATION_OWNER = 'rameezk';

export const tokenFor = (kind: 'read' | 'write' | 'workload', github: string, nth = 1): string =>
  `ghs_${kind}_${github.replace('/', '_')}_${nth}`;

const kindOf = (permissions: Record<string, string> = {}): 'read' | 'write' | 'workload' =>
  'contents' in permissions ? 'workload' : permissions.issues === 'write' ? 'write' : 'read';

export interface Mint {
  installation: string;
  body: { repositories?: string[]; permissions?: Record<string, string> };
  jwt: string;
  kind: 'read' | 'write' | 'workload';
  repository: string;
}

export interface FakeGithubApp {
  fetch: typeof globalThis.fetch;
  privateKey: string;
  mints: Mint[];
  now: { value: number | null };
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

export const fakeGithubApp = (
  installed: string[] = [INSTALLED],
  lifetimeSeconds = 3600,
): FakeGithubApp => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mints: Mint[] = [];
  const now: { value: number | null } = { value: null };
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
    const current = now.value ?? Date.now();
    const seconds = current / 1000;
    if (
      claims === null ||
      claims.iss !== APP_ID ||
      claims.iat > seconds ||
      claims.exp <= seconds ||
      claims.exp - claims.iat > 600
    ) {
      return json({ message: 'A JSON web token could not be decoded' }, 401);
    }
    if (url.pathname === '/app') {
      return json({ id: Number(APP_ID), slug: APP_SLUG, name: 'Forge Test' });
    }
    if (decodeURIComponent(url.pathname) === `/users/${BOT_LOGIN}`) {
      return json({ login: BOT_LOGIN, id: BOT_USER_ID, type: 'Bot' });
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
      const kind = kindOf(body.permissions);
      const repository = `${INSTALLATION_OWNER}/${body.repositories?.[0] ?? ''}`;
      const nth = mints.filter((mint) => mint.kind === kind && mint.repository === repository).length + 1;
      mints.push({ installation: mintFor[1] ?? '', body, jwt, kind, repository });
      return json(
        {
          ...fixture('token'),
          token: tokenFor(kind, repository, nth),
          expires_at: new Date(current + lifetimeSeconds * 1000).toISOString().replace('.000Z', 'Z'),
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

export const routedThrough = (app: FakeGithubApp, other: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const { pathname } = new URL(String(input));
    return /^\/(app(\/|$)|users\/[^/]+(\[bot\]|%5Bbot%5D)$|repos\/[^/]+\/[^/]+\/installation$)/.test(pathname)
      ? app.fetch(input, init)
      : other(input, init);
  };
