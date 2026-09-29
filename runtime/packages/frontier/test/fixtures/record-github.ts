import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRONTIER_PAGE_SIZE, requestFrontierPage } from '@forge/shared';

const [github = 'rameezk/forge', name = 'frontier', size] = process.argv.slice(2);
const first = size === undefined ? FRONTIER_PAGE_SIZE : Number(size);
const token = process.env.GITHUB_TOKEN;
if (token === undefined || token === '') {
  throw new Error('GITHUB_TOKEN is not set');
}

interface Page {
  data?: {
    repository: {
      issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } | null;
  };
}

const pages: Page[] = [];
let after: string | null = null;
do {
  const response = await requestFrontierPage(fetch, token, github, { first, after });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  const page = (await response.json()) as Page;
  pages.push(page);
  const pageInfo = page.data?.repository?.issues.pageInfo;
  after = pageInfo?.hasNextPage === true ? pageInfo.endCursor : null;
} while (after !== null);

const path = join(import.meta.dirname, 'github', `${name}.json`);
writeFileSync(path, `${JSON.stringify(pages, null, 2)}\n`);
console.log(`recorded ${pages.length} page(s) of ${github} to ${path}`);
