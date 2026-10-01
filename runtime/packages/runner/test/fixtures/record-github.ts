import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FRONTIER_PAGE_SIZE,
  requestClosingPullRequests,
  requestLabelledPage,
  requestTicket,
  type Fetch,
} from '@forge/shared';

const REQUESTS = {
  ticket: (fetch: Fetch, token: string, github: string, subject: string) =>
    requestTicket(fetch, token, github, Number(subject)),
  closing: (fetch: Fetch, token: string, github: string, subject: string) =>
    requestClosingPullRequests(fetch, token, github, Number(subject)),
  labelled: (fetch: Fetch, token: string, github: string, subject: string) =>
    requestLabelledPage(fetch, token, github, subject, {
      first: FRONTIER_PAGE_SIZE,
      after: null,
    }),
};

const [github = 'rameezk/forge', kind, subject, name] = process.argv.slice(2);
if (
  kind === undefined ||
  !Object.hasOwn(REQUESTS, kind) ||
  subject === undefined ||
  name === undefined
) {
  throw new Error(
    'usage: record-github.ts <owner/name> ticket|closing <issue> <fixture>, or <owner/name> labelled <label> <fixture>',
  );
}
const token = process.env.GITHUB_TOKEN;
if (token === undefined || token === '') {
  throw new Error('GITHUB_TOKEN is not set');
}

const request = REQUESTS[kind as keyof typeof REQUESTS];
const response = await request(fetch, token, github, subject);
if (!response.ok) {
  throw new Error(`GitHub answered ${response.status}`);
}
const path = join(import.meta.dirname, 'github', `${name}.json`);
writeFileSync(path, `${JSON.stringify(await response.json(), null, 2)}\n`);
console.log(`recorded ${kind} ${subject} of ${github} to ${path}`);
