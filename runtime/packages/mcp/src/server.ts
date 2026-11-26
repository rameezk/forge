import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Operations } from './operations.ts';

const READ_ONLY = { readOnlyHint: true } as const;

const answer = async (produce: () => Promise<unknown>): Promise<CallToolResult> => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await produce(), null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
};

export const createServer = (operations: Operations): McpServer => {
  const server = new McpServer({ name: 'forge-mcp', version: '0.0.0' });

  server.registerTool(
    'ticket',
    {
      title: 'Ticket',
      description: "A ticket's attempts, latest outcome with its failure reason, diagnosis, pull request and dashboard links.",
      inputSchema: {
        repository: z.string().describe("The managed repository's name, as forge knows it, such as forge"),
        number: z.number().int().positive().describe("The ticket's issue number"),
      },
      annotations: READ_ONLY,
    },
    ({ repository, number }) => answer(() => operations.ticket({ repository, number })),
  );

  server.registerTool(
    'running',
    {
      title: 'Running',
      description: 'The dispatches, revisions and conflict resolutions forge is running now, each with its ticket or pull request and how long it has run.',
      annotations: READ_ONLY,
    },
    () => answer(() => operations.running()),
  );

  return server;
};
