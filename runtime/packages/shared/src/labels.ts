import { FORGE_DONE, FORGE_FAILED, FORGE_READY, FORGE_RUNNING } from './dispatch.ts';
import { requireGithubRepository, type Fetch } from './frontier.ts';

export const GITHUB_REST_API = 'https://api.github.com';

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export const FORGE_LABELS: readonly LabelDefinition[] = [
  {
    name: FORGE_READY,
    color: '1d76db',
    description: 'Queued for forge: an agent picks it up once it is on the frontier',
  },
  {
    name: FORGE_RUNNING,
    color: 'fbca04',
    description: 'Forge is running an agent on this ticket',
  },
  {
    name: FORGE_DONE,
    color: '0e8a16',
    description: "Forge's agent opened a pull request that closes this ticket",
  },
  {
    name: FORGE_FAILED,
    color: 'd93f0b',
    description:
      "Forge's agent left no pull request; see forge's dashboard, and set forge:ready to retry",
  },
];

const requestRest = async (
  fetch: Fetch,
  token: string,
  method: string,
  github: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  requireGithubRepository(github);
  return fetch(`${GITHUB_REST_API}/repos/${github}${path}`, {
    method,
    headers: {
      authorization: `bearer ${token}`,
      accept: 'application/vnd.github+json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const labelPath = (label: string): string =>
  `/labels/${encodeURIComponent(label)}`;

export const relabel = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  add: string,
  remove: readonly string[],
): Promise<void> => {
  const added = await requestRest(
    fetch,
    token,
    'POST',
    github,
    `/issues/${number}/labels`,
    { labels: [add] },
  );
  if (!added.ok) {
    throw new Error(
      `GitHub answered ${added.status} labelling ${github}#${number} ${add}`,
    );
  }
  for (const label of remove) {
    const removed = await requestRest(
      fetch,
      token,
      'DELETE',
      github,
      `/issues/${number}${labelPath(label)}`,
    );
    if (!removed.ok && removed.status !== 404) {
      throw new Error(
        `GitHub answered ${removed.status} removing ${label} from ${github}#${number}`,
      );
    }
  }
};

export const labelExists = async (
  fetch: Fetch,
  token: string,
  github: string,
  name: string,
): Promise<boolean> => {
  const existing = await requestRest(fetch, token, 'GET', github, labelPath(name));
  if (existing.status === 404) {
    return false;
  }
  if (!existing.ok) {
    throw new Error(`GitHub answered ${existing.status} reading ${name} in ${github}`);
  }
  return true;
};

const ensureLabel = async (
  fetch: Fetch,
  token: string,
  github: string,
  { name, color, description }: LabelDefinition,
): Promise<void> => {
  const existing = await requestRest(fetch, token, 'GET', github, labelPath(name));
  if (existing.status === 404) {
    const created = await requestRest(fetch, token, 'POST', github, '/labels', {
      name,
      color,
      description,
    });
    if (!created.ok) {
      throw new Error(`GitHub answered ${created.status} creating ${name} in ${github}`);
    }
    return;
  }
  if (!existing.ok) {
    throw new Error(`GitHub answered ${existing.status} reading ${name} in ${github}`);
  }
  const label = (await existing.json()) as { color: string; description: string | null };
  if (label.color.toLowerCase() === color && label.description === description) {
    return;
  }
  const updated = await requestRest(fetch, token, 'PATCH', github, labelPath(name), {
    color,
    description,
  });
  if (!updated.ok) {
    throw new Error(`GitHub answered ${updated.status} updating ${name} in ${github}`);
  }
};

export const ensureLabels = async (
  fetch: Fetch,
  token: string,
  github: string,
): Promise<void> => {
  for (const label of FORGE_LABELS) {
    await ensureLabel(fetch, token, github, label);
  }
};
