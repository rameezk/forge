import { createSign } from 'node:crypto';
import { requireGithubRepository, type Fetch } from './frontier.ts';
import { GITHUB_REST_API } from './labels.ts';

export type TokenAccess = 'read' | 'write' | 'workload';

const PERMISSIONS: Record<TokenAccess, Record<string, 'read' | 'write'>> = {
  read: { issues: 'read', pull_requests: 'read' },
  write: { issues: 'write', pull_requests: 'read' },
  workload: {
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    workflows: 'write',
  },
};

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface GithubAppOptions {
  appId: string;
  privateKey: string;
  fetch: Fetch;
  now: () => number;
}

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

const ok = async (response: Response): Promise<unknown> => {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status}${body.message === undefined ? '' : `: ${body.message}`}`,
    );
  }
  return body;
};

export class GithubApp {
  readonly #options: GithubAppOptions;

  constructor(options: GithubAppOptions) {
    this.#options = options;
  }

  #jwt(): string {
    const { appId, privateKey, now } = this.#options;
    const seconds = Math.floor(now() / 1000);
    const unsigned = [
      base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
      base64url(
        JSON.stringify({
          iat: seconds - JWT_BACKDATE_SECONDS,
          exp: seconds + JWT_LIFETIME_SECONDS,
          iss: appId,
        }),
      ),
    ].join('.');
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
    return `${unsigned}.${base64url(signature)}`;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.#options.fetch(`${GITHUB_REST_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#jwt()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async mint(github: string, access: TokenAccess): Promise<InstallationToken> {
    requireGithubRepository(github);
    const [, name = ''] = github.split('/');
    const lookup = await this.#request('GET', `/repos/${github}/installation`);
    if (lookup.status === 404) {
      throw new Error(`the GitHub App is not installed on ${github}`);
    }
    const installation = (await ok(lookup)) as { id: number };
    const response = await this.#request(
      'POST',
      `/app/installations/${installation.id}/access_tokens`,
      { repositories: [name], permissions: PERMISSIONS[access] },
    );
    const minted = (await ok(response)) as { token: string; expires_at: string };
    return { token: minted.token, expiresAt: minted.expires_at };
  }
}
