import type { Store } from '@forge/shared';

export interface LifecycleScenario {
  seed?: (store: Store) => void;
  maxConcurrent?: number;
  closed?: boolean;
  fromFork?: boolean;
  botLookupFails?: boolean;
  headQueryFails?: boolean;
  targetQueryFails?: boolean;
  beforeFails?: boolean;
  launchThrows?: boolean;
  hangingClone?: boolean;
  setupTimeoutSeconds?: number;
  checkFails?: boolean;
  pushedHead?: string;
  exceeds?: boolean;
}

export interface LifecycleWorkload {
  runId: string | null;
  state: string;
  reason: string | null;
  detail: string | null;
  failedStarts: number | null;
}

export interface LifecycleOutcome {
  code: number;
  thrown: string | null;
  complaints: string;
  harnessStarted: boolean;
  runs: { id: string; status: string; error: string | null }[];
  workloads: LifecycleWorkload[];
  pushedHeads: (string | null)[];
  runsList: string;
}

export interface LifecycleKind {
  name: string;
  command: string;
  main: (argv: string[], env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch) => Promise<number>;
  earlierFailedStart: (store: Store) => void;
  refusal: string;
  livePullRequest: (store: Store) => void;
  extraPrepareFailures: [string, LifecycleScenario][];
  run: (scenario: LifecycleScenario) => Promise<LifecycleOutcome>;
}
