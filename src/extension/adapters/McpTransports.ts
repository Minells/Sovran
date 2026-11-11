/**
 * Transports to MCP servers, built with the official SDK: a child process for local servers (stdio) and Streamable
 * HTTP for remote ones. Free of `vscode` imports so it can be tested against a real process.
 */
import * as fs from 'node:fs/promises';
import { StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '../../core/mcp/config';
import type { McpTransportFactory } from '../../core/mcp/hub';
import {
  commandCandidates,
  commandNotFound,
  McpConfigError,
  resolveLaunch,
  type McpVariables,
} from '../../core/mcp/launch';

export interface McpTransportDeps {
  managedLaunch?: (server: McpServerConfig) => Promise<McpServerConfig>;
  /** Read for every connection: the open folder and the environment may change. */
  variables: () => McpVariables;
  /** The server's token from Secret Storage. */
  token: (serverId: string) => Promise<string | undefined>;
}

export class NodeMcpTransports implements McpTransportFactory {
  constructor(private readonly deps: McpTransportDeps) {}

  async create(server: McpServerConfig, log: (line: string) => void): Promise<Transport> {
    if (server.managed) {
      if (!this.deps.managedLaunch) throw new McpConfigError('Managed integrations are unavailable in this host.');
      server = await this.deps.managedLaunch(server);
    }
    const token = server.auth.type === 'none' ? undefined : await this.deps.token(server.id);
    const launch = resolveLaunch(server, this.deps.variables(), token);
    if (launch.kind === 'http') {
      // The SDK follows a redirect only within the same origin, so headers and tokens never reach another host
      // (the same rule as ADR-021 for model providers).
      return new StreamableHTTPClientTransport(new URL(launch.url), {
        requestInit: { headers: launch.headers },
      });
    }
    // The server's own variables win over the editor's; on Windows names ignore case (Path, PATH).
    const find = (env: Record<string, string | undefined>, name: string) =>
      Object.entries(env).find(([k]) =>
        process.platform === 'win32' ? k.toUpperCase() === name : k === name,
      )?.[1];
    const lookup = (name: string) => find(launch.env, name) ?? find(process.env, name);
    const candidates = commandCandidates(launch.command, {
      cwd: launch.cwd,
      path: lookup('PATH'),
      pathext: lookup('PATHEXT'),
      platform: process.platform,
    });
    if (!(await anyFile(candidates))) throw new McpConfigError(commandNotFound(launch.command));
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

/** Whether one of the files exists (and, outside Windows, may be run). */
async function anyFile(candidates: readonly string[]): Promise<boolean> {
  for (const file of candidates) {
    try {
      await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if ((await fs.stat(file)).isFile()) return true;
    } catch {
      // not this one
    }
  }
  return false;
}
