export const textOf = (fragment: string): string =>
  fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export const openingTag = (element: string): string => element.slice(0, element.indexOf('>') + 1);
