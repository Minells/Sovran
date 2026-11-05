/**
 * Transports to MCP servers, built with the official SDK: a child process for local servers (stdio) and Streamable
 * HTTP for remote ones. Free of `vscode` imports so it can be tested against a real process.
 */
import { StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '../../core/mcp/config';
import type { McpTransportFactory } from '../../core/mcp/hub';
import { resolveLaunch, type McpVariables } from '../../core/mcp/launch';

export interface McpTransportDeps {
  /** Read for every connection: the open folder and the environment may change. */
  variables: () => McpVariables;
  /** The server's token from Secret Storage. */
  token: (serverId: string) => Promise<string | undefined>;
}

export class NodeMcpTransports implements McpTransportFactory {
  constructor(private readonly deps: McpTransportDeps) {}

  async create(server: McpServerConfig, log: (line: string) => void): Promise<Transport> {
    const token = server.auth.type === 'none' ? undefined : await this.deps.token(server.id);
    const launch = resolveLaunch(server, this.deps.variables(), token);
    if (launch.kind === 'http') {
      // The SDK follows a redirect only within the same origin, so headers and tokens never reach another host
      // (the same rule as ADR-021 for model providers).
      return new StreamableHTTPClientTransport(new URL(launch.url), {
        requestInit: { headers: launch.headers },
      });
    }
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      env: launch.env,
      cwd: launch.cwd,
      stderr: 'pipe',
    });
    // stdout carries the protocol; stderr is the server's log, read line by line.
    let pending = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (pending.length > 4000) pending = pending.slice(-4000);
      for (const line of lines) log(line);
    });
    transport.stderr?.on('end', () => {
      if (pending) log(pending);
      pending = '';
    });
    return transport;
  }
}
