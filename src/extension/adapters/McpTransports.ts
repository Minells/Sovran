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
  commandInWorkspace,
  commandNotFound,
  isBareCommand,
  outsideWorkspace,
  McpConfigError,
  resolveLaunch,
  type McpVariables,
} from '../../core/mcp/launch';

export interface McpTransportDeps {
  managedLaunch?: (server: McpServerConfig) => Promise<McpServerConfig>;
  /** Read for every connection: the open folder and the environment may change. */
  variables: () => McpVariables;
  /** The open workspace folders. A bare command is never taken from one of them on Windows. */
  roots?: () => readonly string[];
  /** The server's token from Secret Storage. */
  token: (server: McpServerConfig) => Promise<string | undefined>;
}

export class NodeMcpTransports implements McpTransportFactory {
  constructor(private readonly deps: McpTransportDeps) {}

  async create(server: McpServerConfig, log: (line: string) => void): Promise<Transport> {
    if (server.managed) {
      if (!this.deps.managedLaunch) throw new McpConfigError('Managed integrations are unavailable in this host.');
      server = await this.deps.managedLaunch(server);
    }
    const token = server.auth.type === 'none' ? undefined : await this.deps.token(server);
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
    let command = launch.command;
    if (process.platform === 'win32' && isBareCommand(command, 'win32')) {
      // Started by its full path, so cmd.exe cannot pick a file of the same name from the working folder.
      const trusted = outsideWorkspace(candidates, this.deps.roots?.() ?? [], 'win32');
      const found = await firstFile(trusted);
      if (!found)
        throw new McpConfigError(
          (await firstFile(candidates)) ? commandInWorkspace(command) : commandNotFound(command),
        );
      command = found;
    } else if (!(await firstFile(candidates))) throw new McpConfigError(commandNotFound(command));
    const transport = new StdioClientTransport({
      command,
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

/** The first of the files that exists (and, outside Windows, may be run). */
async function firstFile(candidates: readonly string[]): Promise<string | undefined> {
  for (const file of candidates) {
    try {
      await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
      // not this one
    }
  }
  return undefined;
}
