import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { TicketView } from '@forge/shared';
import { createOperations, createServer, FakeBox } from '../src/index.ts';

const TICKET: TicketView = {
  repository: 'forge',
  number: 7,
  url: null,
  dashboard: '/tickets/forge/7',
  outcome: 'failed',
  failureReason: 'check-failed',
  failureDetail: null,
  pullRequest: null,
  diagnosis: null,
  attempts: [],
};

const connected = async (box: FakeBox) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(createOperations({ box })).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
};

test('given the MCP server, when a client lists its tools, then frontier, repository, running and ticket are listed and carry readOnlyHint', async () => {
  const { tools } = await (await connected(new FakeBox())).listTools();

  assert.deepEqual(tools.map(({ name }) => name).sort(), ['frontier', 'repository', 'running', 'ticket']);
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
});

test('given a fake box holding a ticket, when a client calls the ticket tool, then the result is the ticket as JSON', async () => {
  const client = await connected(new FakeBox({ tickets: [TICKET] }));

  const result = await client.callTool({ name: 'ticket', arguments: { repository: 'forge', number: 7 } });

  const [content] = result.content as { type: string; text: string }[];
  assert.equal(content?.type, 'text');
  const ticket = JSON.parse(content!.text) as TicketView;
  assert.equal(ticket.failureReason, 'check-failed');
  assert.equal(ticket.dashboard, 'http://box.test/tickets/forge/7');
});

test('given a box that cannot be reached, when a client calls a tool, then the result is an error naming why', async () => {
  const box = new FakeBox();
  box.fail('the box is unreachable');
  const result = await (await connected(box)).callTool({ name: 'running', arguments: {} });

  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /the box is unreachable/);
});
