import { requireGithubRepository, type Fetch } from './frontier.ts';

export const GITHUB_REST_API = 'https://api.github.com';

const MAINTAINER_PERMISSIONS = new Set(['write', 'admin']);

export interface Actor {
  __typename: string;
  login: string;
}

export type MaintainerLookup = (author: Actor | null) => Promise<boolean>;

export const maintainerLookup = (fetch: Fetch, token: string, github: string): MaintainerLookup => {
  requireGithubRepository(github);
  const known = new Map<string, Promise<boolean>>();
  const permissionOf = async (login: string): Promise<boolean> => {
    const response = await fetch(
      `${GITHUB_REST_API}/repos/${github}/collaborators/${encodeURIComponent(login)}/permission`,
      {
        headers: {
          authorization: `bearer ${token}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for the permission of ${login} on ${github}`);
    }
    const { permission } = (await response.json()) as { permission?: string };
    return permission !== undefined && MAINTAINER_PERMISSIONS.has(permission);
  };
  return async (author) => {
    if (author === null || author.__typename === 'Bot') return false;
    const key = author.login.toLowerCase();
    let answer = known.get(key);
    if (answer === undefined) {
      answer = permissionOf(author.login);
      known.set(key, answer);
      answer.catch(() => known.delete(key));
    }
    return answer;
  };
};
