import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const assetPath = (name: string, extension: string, content: string): string =>
  `/assets/${name}-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.${extension}`;

export const readStylesheet = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `the dashboard stylesheet is not built at ${path}; run npm run build in the runtime first`,
      { cause: error },
    );
  }
};
