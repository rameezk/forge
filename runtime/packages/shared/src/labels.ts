import { isGithubRepository, type Fetch } from './frontier.ts';

export const GITHUB_REST_API = 'https://api.github.com';

export const FORGE_READY = 'forge:ready';
export const FORGE_RUNNING = 'forge:running';
export const FORGE_DONE = 'forge:done';
export const FORGE_FAILED = 'forge:failed';

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
  if (!isGithubRepository(github)) {
    throw new Error(`'${github}' is not a GitHub owner/name`);
  }
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

export const swapLabel = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  from: string,
  to: string,
): Promise<void> => {
  const added = await requestRest(
    fetch,
    token,
    'POST',
    github,
    `/issues/${number}/labels`,
    { labels: [to] },
  );
  if (!added.ok) {
    throw new Error(
      `GitHub answered ${added.status} labelling ${github}#${number} ${to}`,
    );
  }
  const removed = await requestRest(
    fetch,
    token,
    'DELETE',
    github,
    `/issues/${number}${labelPath(from)}`,
  );
  if (!removed.ok && removed.status !== 404) {
    throw new Error(
      `GitHub answered ${removed.status} removing ${from} from ${github}#${number}`,
    );
  }
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
