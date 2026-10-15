export const textOf = (fragment: string): string =>
  fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export const openingTag = (element: string): string => element.slice(0, element.indexOf('>') + 1);

export const tileValue = (body: string, name: string): string =>
  body.match(new RegExp(`<div[^>]*\\sdata-tile="${name}"[^>]*>\\s*<span[^>]*>[^<]*</span>\\s*<div[^>]*\\sdata-tile-value[^>]*>([\\s\\S]*?)</div>`))?.[1] ?? 'missing';

export const tile = (body: string, name: string): string =>
  body.match(new RegExp(`<div[^>]*\\sdata-tile="${name}"[^>]*>[\\s\\S]*?</div>\\s*(?:<span[^>]*>[\\s\\S]*?</span>\\s*)?</div>`))?.[0] ?? 'missing';
