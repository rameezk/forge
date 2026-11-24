import type { Connection } from './connection.ts';
import { migrateAutoMerge } from './migrations/auto-merge.ts';
import { migrateDiagnoses } from './migrations/diagnoses.ts';
import { migrateFrontier } from './migrations/frontier.ts';
import { migrateGrades } from './migrations/grades.ts';
import { migrateRuns } from './migrations/runs.ts';
import { migrateUrgency } from './urgency.ts';
import { migrateWorkloads } from './migrations/workloads.ts';

interface ConcernMigration {
  readonly name: string;
  readonly migrate: (connection: Connection) => void;
}

export const CONCERNS: readonly ConcernMigration[] = [
  { name: 'runs', migrate: migrateRuns },
  { name: 'frontier', migrate: migrateFrontier },
  { name: 'workloads', migrate: migrateWorkloads },
  { name: 'grades', migrate: migrateGrades },
  { name: 'urgency', migrate: migrateUrgency },
  { name: 'autoMerge', migrate: migrateAutoMerge },
  { name: 'diagnoses', migrate: migrateDiagnoses },
];

const useWriteAheadLog = (connection: Connection): void => {
  const { journal_mode } = connection.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  if (journal_mode === 'wal') {
    return;
  }
  connection.exec('BEGIN IMMEDIATE');
  connection.exec('ROLLBACK');
  connection.exec('PRAGMA journal_mode = WAL');
};

export const migrate = (connection: Connection): void => {
  useWriteAheadLog(connection);
  for (const concern of CONCERNS) {
    concern.migrate(connection);
  }
};
