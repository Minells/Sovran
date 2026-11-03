import * as path from 'node:path';
import picomatch from 'picomatch';
import type {
  ApprovalPort,
  ApprovalRequest,
  ApprovalResponse,
  DirEntry,
  EditorContext,
  FileStat,
  ProcessPort,
  ProcessResult,
  WorkspacePort,
  WorkspaceRoot,
} from '../../src/core/ports';
import type { ChatProvider, ChatRequest, ProviderEvent } from '../../src/core/providers/types';

/** In-memory workspace rooted at an absolute path; supports simulated symlinks. */
export class MemoryWorkspace implements WorkspacePort {
  readonly root = path.resolve('/ws');
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>([this.root]);
  /** absolute path prefix → real target (for symlink tests). */
  readonly links = new Map<string, string>();
  trusted = true;
  active: EditorContext | null = null;
  writes: string[] = [];

  constructor(files: Record<string, string> = {}) {
    for (const [rel, content] of Object.entries(files)) this.set(rel, content);
  }

  abs(rel: string) {
    return path.resolve(this.root, rel);
  }

  set(rel: string, content: string) {
    const abs = this.abs(rel);
    this.files.set(abs, content);
    for (let d = path.dirname(abs); d.startsWith(this.root); d = path.dirname(d)) {
      this.dirs.add(d);
      if (d === this.root) break;
    }
  }

  get(rel: string) {
    return this.files.get(this.abs(rel));
  }

  roots(): WorkspaceRoot[] {
    return [{ name: 'ws', path: this.root }];
  }
  isTrusted() {
    return this.trusted;
  }
  async stat(abs: string): Promise<FileStat | null> {
    if (this.files.has(abs)) return { type: 'file', size: this.files.get(abs)!.length, mtimeMs: 0 };
    if (this.dirs.has(abs)) return { type: 'directory', size: 0, mtimeMs: 0 };
    return null;
  }
  async realpath(abs: string) {
    for (const [link, target] of this.links) {
      if (abs === link || abs.startsWith(link + path.sep)) return target + abs.slice(link.length);
    }
    return abs;
  }
  async readFile(abs: string) {
    const v = this.files.get(abs);
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${abs}`), { code: 'ENOENT' });
    return v;
  }
  async readDirectory(abs: string): Promise<DirEntry[]> {
    const out = new Map<string, DirEntry>();
    const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const [first, ...rest] = f.slice(prefix.length).split(path.sep);
      if (first) out.set(first, { name: first, type: rest.length ? 'directory' : 'file' });
    }
    return [...out.values()];
  }
  async findFiles(include: string, options: { maxResults: number }) {
    const isMatch = picomatch(include, { dot: true });
    return [...this.files.keys()]
      .filter((f) => isMatch(path.relative(this.root, f).split(path.sep).join('/')))
      .slice(0, options.maxResults);
  }
  async writeFile(abs: string, content: string) {
    this.writes.push(abs);
    this.set(path.relative(this.root, abs), content);
  }
  activeEditor() {
    return this.active;
  }
  openEditors() {
    return [];
  }
  environment() {
    return { os: 'linux', shell: 'bash' };
  }
}

export class FakeProcess implements ProcessPort {
  commands: Array<{ command: string; cwd: string }> = [];
  constructor(private readonly result: Partial<ProcessResult> = {}) {}
  async run(command: string, options: { cwd: string; onOutput?: (c: string) => void }): Promise<ProcessResult> {
    this.commands.push({ command, cwd: options.cwd });
    const output = this.result.output ?? `ran ${command}`;
    options.onOutput?.(output);
    return { exitCode: 0, signal: null, output, truncated: false, timedOut: false, cancelled: false, durationMs: 5, ...this.result };
  }
}

export class ScriptedApprovals implements ApprovalPort {
  requests: ApprovalRequest[] = [];
  constructor(private readonly respond: (r: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse> = () => ({ approved: true })) {}
  async request(r: ApprovalRequest) {
    this.requests.push(r);
    return this.respond(r);
  }
}

type Turn = ProviderEvent[] | Error | ((req: ChatRequest) => ProviderEvent[] | Error);

/** Provider that replays one scripted turn per request and records every request. */
export class ScriptedProvider implements ChatProvider {
  readonly id = 'test';
  requests: ChatRequest[] = [];
  constructor(private readonly turns: Turn[]) {}
  async listModels() {
    return ['model-a'];
  }
  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    this.requests.push(structuredClone(req));
    let turn = this.turns.shift() ?? [{ type: 'text', text: 'done' }];
    if (typeof turn === 'function') turn = turn(req);
    if (turn instanceof Error) throw turn;
    for (const ev of turn) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield ev;
    }
  }
}

export const text = (t: string): ProviderEvent => ({ type: 'text', text: t });
export const call = (index: number, name: string, args: unknown, id = `c${index}`): ProviderEvent => ({
  type: 'tool_call_delta',
  index,
  id,
  name,
  argumentsDelta: typeof args === 'string' ? args : JSON.stringify(args),
});
