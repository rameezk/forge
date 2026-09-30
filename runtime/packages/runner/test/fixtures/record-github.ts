import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestTicket } from '@forge/shared';

const [github = 'rameezk/forge', number, name] = process.argv.slice(2);
if (number === undefined || name === undefined) {
  throw new Error('usage: record-github.ts <owner/name> <issue> <fixture>');
}
const token = process.env.GITHUB_TOKEN;
if (token === undefined || token === '') {
  throw new Error('GITHUB_TOKEN is not set');
}

const response = await requestTicket(fetch, token, github, Number(number));
if (!response.ok) {
  throw new Error(`GitHub answered ${response.status}`);
}
const path = join(import.meta.dirname, 'github', `${name}.json`);
writeFileSync(path, `${JSON.stringify(await response.json(), null, 2)}\n`);
console.log(`recorded ${github}#${number} to ${path}`);
