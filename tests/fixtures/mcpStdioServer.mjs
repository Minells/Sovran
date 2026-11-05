// A real MCP server over stdio for the transport tests: it reports what it was started with.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool(
  'whoami',
  { description: 'Reports the environment the server runs in.', inputSchema: z.object({}) },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          token: process.env.DEMO_TOKEN ?? null,
          mode: process.env.DEMO_MODE ?? null,
          proxy: process.env.HTTPS_PROXY ?? null,
          unrelated: process.env.SOVRAN_TEST_UNRELATED ?? null,
          electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
          cwd: process.cwd(),
          args: process.argv.slice(2),
        }),
      },
    ],
  }),
);
server.registerTool(
  'slow',
  { description: 'Answers after a while.', inputSchema: z.object({ ms: z.number() }) },
  async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { content: [{ type: 'text', text: 'late' }] };
  },
);
server.registerTool('crash', { description: 'Exits the process.', inputSchema: z.object({}) }, async () => {
  console.error('fatal: crashing on purpose');
  setTimeout(() => process.exit(3), 10);
  return { content: [{ type: 'text', text: 'bye' }] };
});
console.error('fixture server ready');
await server.connect(new StdioServerTransport());
