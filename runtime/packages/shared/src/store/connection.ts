import { DatabaseSync, type StatementSync } from 'node:sqlite';

export const BUSY_TIMEOUT_MS = 5000;

export interface Connection {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  transaction(work: () => void): void;
  close(): void;
}

export const openConnection = (path: string, options: { readOnly?: boolean } = {}): Connection => {
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false, timeout: BUSY_TIMEOUT_MS });
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    transaction: (work) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        work();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
};
