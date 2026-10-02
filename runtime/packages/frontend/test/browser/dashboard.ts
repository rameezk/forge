import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { test as base } from '@playwright/test';
import { Store } from '@forge/shared';
import { createDashboard } from '../../src/main.ts';

type Dashboard = { url: string; store: Store; dropConnections: () => void; stop: () => Promise<void> };

export const test = base.extend<{ dashboard: Dashboard }>({
  dashboard: async ({}, use) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'forge-dashboard-'));
    const store = Store.open(join(stateDir, 'forge.db'));
    const served = Store.open(join(stateDir, 'forge.db'));
    const app = createDashboard(stateDir, served, { checkIntervalMs: 50 });
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
    await use({ url: `http://127.0.0.1:${port}`, store, dropConnections, stop });
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
