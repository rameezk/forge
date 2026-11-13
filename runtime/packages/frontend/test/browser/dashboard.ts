import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { test as base } from '@playwright/test';
import { Store, transcriptLine } from '@forge/shared';
import type { HarnessEvent } from '@forge/shared';
import { createDashboard } from '../../src/main.ts';
import type { DeployStatus } from '../../src/deploy-status.ts';

type Dashboard = {
  url: string;
  store: Store;
  setDeployStatus: (status: Partial<DeployStatus> | null) => void;
  appendEvents: (ref: string, ...events: HarnessEvent[]) => void;
  dropConnections: () => void;
  stop: () => Promise<void>;
};

export const test = base.extend<{ dashboard: Dashboard }>({
  dashboard: async ({}, use) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'forge-dashboard-'));
    const store = Store.open(join(stateDir, 'forge.db'));
    const served = Store.open(join(stateDir, 'forge.db'));
    const transcripts = join(stateDir, 'transcripts');
    mkdirSync(transcripts);
    const appendEvents = (ref: string, ...events: HarnessEvent[]) =>
      appendFileSync(join(transcripts, ref), events.map(transcriptLine).join(''));
    let deploy: DeployStatus | null = null;
    const setDeployStatus = (status: Partial<DeployStatus> | null) => {
      deploy = status === null ? null : { running: null, head: null, error: null, bumpError: null, forge: null, upstream: null, upstreamHead: null, behind: null, ...status };
    };
    const app = createDashboard(stateDir, served, { checkIntervalMs: 50, deployStatus: () => deploy, gradingRepositories: ['forge'] });
    const server = await new Promise<Server>((resolve) => {
      const started = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(started as Server));
    });
    const { port } = server.address() as AddressInfo;
    let stopped: Promise<void> | undefined;
    const stop = () => {
      stopped ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return stopped;
    };
    const dropConnections = () => server.closeAllConnections();
    await use({ url: `http://127.0.0.1:${port}`, store, setDeployStatus, appendEvents, dropConnections, stop });
    await stop();
    served.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  },
  baseURL: async ({ dashboard }, use) => {
    await use(dashboard.url);
  },
});

export { expect } from '@playwright/test';
