export const isHeaderValue = (value: string): boolean =>
  /^[\x21-\x7e]+$/.test(value);
