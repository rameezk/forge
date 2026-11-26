import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BOX_ADDRESS_VARIABLE, boxAddressFrom, HttpBox } from './box.ts';
import { createOperations } from './operations.ts';
import { createServer } from './server.ts';

export const main = async (env: NodeJS.ProcessEnv): Promise<void> => {
  const box = new HttpBox(boxAddressFrom(env[BOX_ADDRESS_VARIABLE]));
  await createServer(createOperations({ box })).connect(new StdioServerTransport());
};

if (import.meta.filename === process.argv[1]) {
  main(process.env).catch((error: unknown) => {
    console.error(`forge-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
