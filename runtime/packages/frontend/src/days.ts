import { partsIn } from './format.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const offsetAt = (time: number, timeZone: string): number => {
  const { year, month, day, hour, minute, second } = partsIn(time, timeZone);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - Math.floor(time / 1000) * 1000;
};

export const nextDay = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export const startOfDay = (date: string, timeZone: string): number => {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return midnight - offsetAt(midnight - offsetAt(midnight, timeZone), timeZone);
};

export const dayOf = (time: number, timeZone: string): string => {
  const { year, month, day } = partsIn(time, timeZone);
  return `${year}-${month}-${day}`;
};
