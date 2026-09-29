import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRONTIER_QUERY, GITHUB_GRAPHQL_API } from '@forge/shared';

const [github = 'rameezk/forge', name = 'frontier'] = process.argv.slice(2);
const [owner, repository] = github.split('/');
const token = process.env.GITHUB_TOKEN;
if (token === undefined || token === '') {
  throw new Error('GITHUB_TOKEN is not set');
}

const response = await fetch(GITHUB_GRAPHQL_API, {
  method: 'POST',
  headers: {
    authorization: `bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    query: FRONTIER_QUERY,
    variables: { owner, name: repository },
  }),
});
if (!response.ok) {
  throw new Error(`GitHub answered ${response.status}`);
}

const path = join(import.meta.dirname, 'github', `${name}.json`);
writeFileSync(path, `${JSON.stringify(await response.json(), null, 2)}\n`);
console.log(`recorded ${github} to ${path}`);
