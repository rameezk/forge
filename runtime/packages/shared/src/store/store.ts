import type { SQLInputValue } from 'node:sqlite';
import { openConnection, type Connection } from './connection.ts';
import { Grades } from './grades.ts';
import { migrate } from './migrate.ts';
import { Workloads } from './workloads.ts';
import { AutoMerge } from './auto-merge.ts';
import { Diagnoses } from './diagnoses.ts';
import { Frontier } from './frontier.ts';
import { Insights } from './insights.ts';
import { Runs } from './runs.ts';
import { Urgency } from './urgency.ts';

export class Store {
  readonly #db: Connection;
  readonly grades: Grades;
  readonly workloads: Workloads;
  readonly runs: Runs;
  readonly diagnoses: Diagnoses;
  readonly autoMerge: AutoMerge;
  readonly urgency: Urgency;
  readonly frontier: Frontier;
  readonly insights: Insights;

  private constructor(db: Connection) {
    this.#db = db;
    this.runs = new Runs(db);
    this.diagnoses = new Diagnoses(db);
    this.workloads = new Workloads(db, {
      getRun: (id) => this.runs.getRun(id),
      getFingerprint: (id) => this.runs.getFingerprint(id),
    });
    this.autoMerge = new AutoMerge(db);
    this.grades = new Grades(db, (pullRequest, closes, now) => this.workloads.pullRequestLive(pullRequest, closes, now));
    this.urgency = new Urgency(db);
    this.frontier = new Frontier(db, this.workloads);
    this.insights = new Insights(db);
  }

  static open(path: string): Store {
    const connection = openConnection(path);
    migrate(connection);
    return new Store(connection);
  }

  static openReadOnly(path: string): Store {
    return new Store(openConnection(path, { readOnly: true }));
  }

  read<Row>(sql: string, parameters: Record<string, SQLInputValue> = {}): Row[] {
    return this.#db.prepare(sql).all(parameters) as Row[];
  }

  dataVersion(): number {
    const { data_version } = this.#db.prepare('PRAGMA data_version').get() as {
      data_version: number;
    };
    return data_version;
  }

  close(): void {
    this.#db.close();
  }
}
