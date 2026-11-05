/**
 * Real MCP servers for tests, connected in memory: the SDK's own `McpServer` on one end of an `InMemoryTransport`
 * pair, Sovran's `McpHub` on the other. No process and no socket.
 */
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpServerConfig } from '../../src/core/mcp/config';
import type { McpTransportFactory } from '../../src/core/mcp/hub';

export function server(overrides: Partial<McpServerConfig> & { id: string }): McpServerConfig {
  return {
    name: overrides.id,
    enabled: true,
    command: 'node',
    auth: { type: 'none' },
    timeoutSeconds: 60,
    allowedTools: [],
    disabledTools: [],
    ...overrides,
  };
}

/** A small "notes" server: one read-only tool, one that changes data, one that fails. */
export function notesServer(): McpServer {
  const s = new McpServer({ name: 'notes', version: '1.2.0' });
  const notes = new Map<string, string>([['welcome', 'Hello from MCP']]);
  s.registerTool(
    'read_note',
    {
      title: 'Read note',
      description: 'Reads a note by name.',
      inputSchema: z.object({ name: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => ({ content: [{ type: 'text', text: notes.get(name) ?? `No note named ${name}` }] }),
  );
  s.registerTool(
    'delete_note',
    {
      description: 'Deletes a note.',
      inputSchema: z.object({ name: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ name }) => {
      notes.delete(name);
      return { content: [{ type: 'text', text: `Deleted ${name}` }] };
    },
  );
  s.registerTool('broken', { description: 'Always fails.', inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'disk full' }],
    isError: true,
  }));
  return s;
}

/** Connects each configured id to a fresh server from `factories`; `created` counts connections per id. */
export class MemoryTransports implements McpTransportFactory {
  readonly created = new Map<string, number>();
  readonly servers = new Map<string, McpServer>();
  constructor(private readonly factories: Record<string, () => McpServer>) {}
  async create(config: McpServerConfig, log: (line: string) => void): Promise<Transport> {
    const make = this.factories[config.id];
    if (!make) throw new Error(`no test server for ${config.id}`);
    this.created.set(config.id, (this.created.get(config.id) ?? 0) + 1);
    const [client, srv] = InMemoryTransport.createLinkedPair();
    const instance = make();
    this.servers.set(config.id, instance);
    await instance.connect(srv);
    log(`${config.id} ready`);
    return client;
  }
}

/** Resolves once `check` holds, polling briefly (hub updates are asynchronous). */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
