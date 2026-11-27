import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { boxAddressFrom, HttpBox } from '../src/index.ts';

const serving = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { address: `http://127.0.0.1:${port}`, close: () => server.close() };
};

test('given a box serving the JSON interface, when the HTTP box reads a ticket and what is running, then it asks the read routes and returns their bodies', async () => {
  const requests: string[] = [];
  const box = await serving((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/running' ? '{"dispatches":[],"revisions":[],"conflictResolutions":[]}' : '{"repository":"a b","number":7}');
  });
  try {
    const http = new HttpBox(box.address);
    assert.deepEqual(await http.running(), { dispatches: [], revisions: [], conflictResolutions: [] });
    assert.equal((await http.ticket('a b', 7)).number, 7);
    assert.deepEqual(requests, ['GET /api/running', 'GET /api/tickets/a%20b/7']);
    assert.equal(http.link('/runs/x'), `${box.address}/runs/x`);
  } finally {
    box.close();
  }
});

test('given a box answering an error, when the HTTP box reads from it, then it fails naming the status', async () => {
  const box = await serving((_req, res) => {
    res.statusCode = 502;
    res.end('bad gateway');
  });
  try {
    await assert.rejects(new HttpBox(box.address).running(), /502/);
  } finally {
    box.close();
  }
});

test('given a box that redirects, when the HTTP box reads from it, then it does not follow the redirect', async () => {
  let followed = false;
  const elsewhere = await serving((_req, res) => {
    followed = true;
    res.end('{}');
  });
  const box = await serving((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', elsewhere.address);
    res.end();
  });
  try {
    await assert.rejects(new HttpBox(box.address).running());
    assert.equal(followed, false);
  } finally {
    box.close();
    elsewhere.close();
  }
});

test('given a path that would leave the box, when a link is built from it, then it is refused', () => {
  const http = new HttpBox('http://forge-box');
  for (const path of ['@evil.example/x', '//evil.example/x', '/\\evil.example', 'runs/x']) {
    assert.throws(() => http.link(path), /dashboard path/, path);
  }
});

test('given a repository named like a dot segment, when the HTTP box reads its ticket, then it refuses before asking the box', async () => {
  const requests: string[] = [];
  const box = await serving((req, res) => {
    requests.push(req.url ?? '');
    res.end('{}');
  });
  try {
    for (const repository of ['.', '..']) {
      await assert.rejects(new HttpBox(box.address).ticket(repository, 7), /repository/);
    }
    assert.deepEqual(requests, []);
  } finally {
    box.close();
  }
});

test('given a box address, when it is normalised, then a bare host gets http and a trailing slash is dropped', () => {
  assert.equal(boxAddressFrom('forge-box'), 'http://forge-box');
  assert.equal(boxAddressFrom('forge-box.tail1234.ts.net:8080/'), 'http://forge-box.tail1234.ts.net:8080');
  assert.equal(boxAddressFrom('https://forge.example/'), 'https://forge.example');
  assert.throws(() => boxAddressFrom(undefined), /FORGE_BOX_ADDRESS/);
  assert.throws(() => boxAddressFrom('  '), /FORGE_BOX_ADDRESS/);
});

test('given a box serving the JSON interface, when the HTTP box reads the frontier and a repository, then it asks their routes', async () => {
  const requests: string[] = [];
  const box = await serving((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/frontier' ? '{"repositories":[]}' : '{"repository":"a b","polling":true}');
  });
  try {
    const http = new HttpBox(box.address);
    assert.deepEqual(await http.frontier(), { repositories: [] });
    assert.equal((await http.repository('a b')).polling, true);
    assert.deepEqual(requests, ['GET /api/frontier', 'GET /api/repositories/a%20b']);
  } finally {
    box.close();
  }
});

test('given a repository named like a dot segment, when the HTTP box reads its health, then it refuses before asking the box', async () => {
  const http = new HttpBox('http://127.0.0.1:1');
  for (const repository of ['.', '..']) await assert.rejects(http.repository(repository), /repository/);
});
