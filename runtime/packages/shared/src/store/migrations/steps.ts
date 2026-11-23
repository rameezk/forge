import type { Connection } from '../connection.ts';

export const addColumnsOnce = (connection: Connection, present: string, add: string): void => {
  const has = (): boolean => connection.prepare(present).get() !== undefined;
  if (has()) {
    return;
  }
  connection.transaction(() => {
    if (!has()) {
      connection.exec(add);
    }
  });
};

export const migrateWhenNeeded = (connection: Connection, needed: string, migrate: string): void => {
  const isNeeded = (): boolean => connection.prepare(needed).get() !== undefined;
  if (!isNeeded()) {
    return;
  }
  connection.transaction(() => {
    if (isNeeded()) {
      connection.exec(migrate);
    }
  });
};
