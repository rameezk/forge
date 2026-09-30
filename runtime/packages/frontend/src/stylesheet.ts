import { createHash } from 'node:crypto';

export const stylesheetPath = (css: string): string =>
  `/assets/dashboard-${createHash('sha256').update(css).digest('hex').slice(0, 16)}.css`;
