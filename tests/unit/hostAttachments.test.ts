/**
 * Host side of the attach menu, on a real folder: listing, suggestions, attaching and uploading. The VS Code API is a
 * small in-memory stand-in; file-system checks (realpath, binary detection) run for real.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, FileStat, WorkspaceRoot } from '../../src/core/ports';
import { displayPath } from '../../src/core/util/files';
import type { HostMessage } from '../../src/shared/protocol';

const h = vi.hoisted(() => ({
  root: '',
  activeFile: undefined as string | undefined,
  openTabs: [] as string[],
  config: {} as Record<string, unknown>,
  warningAnswer: undefined as string | undefined,
  warnings: [] as string[],
  dialog: undefined as string[] | undefined,
}));

vi.mock('vscode', async () => {
  const p = await import('node:path');
  const fsp = await import('node:fs/promises');
  const Uri = { file: (f: string) => ({ scheme: 'file', fsPath: f, path: f }) };
  const inside = (f: string) => f === h.root || f.startsWith(h.root + p.sep);
  const folder = () => ({ uri: Uri.file(h.root), name: 'proj', index: 0 });
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === '.git') continue;
      const f = p.join(dir, d.name);
      if (d.isDirectory()) out.push(...(await walk(f)));
      else if (d.isFile()) out.push(f);
    }
    return out;
  };
  const noop = () => ({ dispose() {} });
  return {
    Uri,
    workspace: {
      name: 'proj',
      isTrusted: true,
      get workspaceFolders() {
        return [folder()];
      },
      getWorkspaceFolder: (uri: { fsPath: string }) => (inside(uri.fsPath) ? folder() : undefined),
      asRelativePath: (target: string | { fsPath: string }) => {
        const abs = typeof target === 'string' ? target : target.fsPath;
        return inside(abs) ? p.relative(h.root, abs).split(p.sep).join('/') : abs;
      },
      getConfiguration: (section: string) => ({
        get: <T>(key: string, fallback?: T) => (`${section}.${key}` in h.config ? (h.config[`${section}.${key}`] as T) : fallback),
        inspect: (key: string) => ({ defaultValue: h.config[`${section}.${key}`], globalValue: undefined }),
      }),
      findFiles: async () => (await walk(h.root)).map(Uri.file),
      createFileSystemWatcher: () => ({ onDidCreate: noop, onDidDelete: noop, onDidChange: noop, dispose() {} }),
    },
    window: {
      get activeTextEditor() {
        return h.activeFile ? { document: { uri: Uri.file(h.activeFile) } } : undefined;
      },
      showWarningMessage: async (message: string) => {
        h.warnings.push(message);
        return h.warningAnswer;
      },
      showOpenDialog: async () => h.dialog?.map(Uri.file),
    },
  };
});

const { SovranController } = await import('../../src/extension/SovranController');
const { FileIndex } = await import('../../src/extension/workspaceServices');
type Controller = InstanceType<typeof SovranController>;

/** WorkspacePort over the real disk, rooted at the temporary project. */
class DiskWorkspace {
  roots(): WorkspaceRoot[] {
    return [{ name: 'proj', path: h.root }];
  }
  async stat(abs: string): Promise<FileStat | null> {
    try {
      const s = await fs.stat(abs);
      return { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }
  realpath(abs: string) {
    return fs.realpath(abs);
  }
  async readDirectory(abs: string): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    for (const d of await fs.readdir(abs, { withFileTypes: true })) {
      const s = await fs.stat(path.join(abs, d.name)).catch(() => null);
      out.push({ name: d.name, type: s?.isDirectory() ? 'directory' : s?.isFile() ? 'file' : 'other' });
    }
    return out;
  }
  readFile(abs: string) {
    return fs.readFile(abs, 'utf8');
  }
  openEditors() {
    return h.openTabs;
  }
}

let tmp: string;
let outside: string;
let messages: HostMessage[];
let controller: Controller;

const write = async (rel: string, content: string | Uint8Array, base = h.root) => {
  const f = path.join(base, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, content);
  return f;
};
const last = <T extends HostMessage['type']>(type: T) => [...messages].reverse().find((m) => m.type === type) as Extract<HostMessage, { type: T }>;
const attachments = () => last('patch')?.patch.context?.attachments ?? [];
const notices = () => messages.flatMap((m) => (m.type === 'notice' ? [m.message] : []));

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-attach-')));
  h.root = path.join(tmp, 'proj');
  outside = path.join(tmp, 'outside');
  h.config = {
    'sovran.security.protectedPaths': ['**/.env', '**/*.pem'],
    'files.exclude': { '**/*.log': true, '**/kept': false },
  };
  h.activeFile = undefined;
  h.openTabs = [];
  h.warningAnswer = undefined;
  h.warnings = [];
  h.dialog = undefined;
  await write('src/a.ts', 'export const a = 1;\n');
  await write('src/b.ts', 'export const b = 2;\n');
  await write('src/file10.ts', '');
  await write('src/file2.ts', '');
  await write('README.md', '# proj\n');
  await write('.env', 'TOKEN=secret\n');
  await write('debug.log', 'noise\n');
  await write('kept/x.txt', 'x\n');
  await write('logo.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
  await write('node_modules/dep/index.js', '');
  await write('.git/HEAD', 'ref: refs/heads/main\n');
  await write('notes.md', '# notes from elsewhere\n', outside);
  await write('blob.bin', Uint8Array.from([0, 1, 2, 3]), outside);
  // A junction on Windows needs no extra privilege; other platforms ignore the type and create a symbolic link.
  await fs.symlink(outside, path.join(h.root, 'escape'), 'junction');

  messages = [];
  controller = new SovranController({
    workspace: new DiskWorkspace(),
    fileIndex: new FileIndex(),
    logger: { debug() {}, info() {}, warn() {}, error() {}, show() {}, addSecret() {}, dispose() {} },
  } as never);
  controller.attach((m) => messages.push(m));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('listDirectory', () => {
  it('lists folders first in natural order, hides VCS and dependency folders, honours files.exclude and marks protected files', async () => {
    await controller.handle({ type: 'listDirectory', requestId: 'r1', path: '' });
    const { requestId, listing } = last('directoryListing');
    expect(requestId).toBe('r1');
    expect(listing.path).toBe('');
    expect(listing.entries.map((e) => e.name)).toEqual(['escape', 'kept', 'src', '.env', 'logo.png', 'README.md']);
    expect(listing.entries.find((e) => e.name === '.env')).toMatchObject({ type: 'file', protected: true });

    await controller.handle({ type: 'listDirectory', requestId: 'r2', path: 'src/' });
    expect(last('directoryListing').listing).toMatchObject({ path: 'src' });
    expect(last('directoryListing').listing.entries.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/file2.ts', 'src/file10.ts']);
  });

  it('stays inside the workspace, also through symbolic links', async () => {
    await controller.handle({ type: 'listDirectory', requestId: 'r1', path: '../outside' });
    expect(last('directoryListing').listing).toMatchObject({ entries: [], error: expect.stringMatching(/escapes the workspace/) });
    await controller.handle({ type: 'listDirectory', requestId: 'r2', path: 'escape' });
    expect(last('directoryListing').listing).toMatchObject({ entries: [], error: expect.any(String) });
    await controller.handle({ type: 'listDirectory', requestId: 'r3', path: outside });
    expect(last('directoryListing').listing.error).toMatch(/outside the workspace/);
  });
});

describe('suggestFiles', () => {
  it('puts the active editor and open tabs first, without protected or outside files', async () => {
    h.activeFile = path.join(h.root, 'src/b.ts');
    h.openTabs = [path.join(h.root, '.env'), path.join(outside, 'notes.md'), path.join(h.root, 'README.md'), h.activeFile];
    await controller.handle({ type: 'suggestFiles', requestId: 'q1', query: '' });
    const items = last('fileSuggestions').items;
    expect(items.slice(0, 2)).toEqual([
      { path: 'src/b.ts', label: 'b.ts', hint: 'active' },
      { path: 'README.md', label: 'README.md', hint: 'open' },
    ]);
    expect(items.filter((i) => i.hint)).toHaveLength(2);

    await controller.handle({ type: 'suggestFiles', requestId: 'q2', query: 'readme' });
    expect(last('fileSuggestions').items[0]).toEqual({ path: 'README.md', label: 'README.md' });
  });
});

describe('attachPath', () => {
  it('attaches a workspace text file once', async () => {
    await controller.handle({ type: 'attachPath', path: 'src/a.ts' });
    await controller.handle({ type: 'attachPath', path: 'src/a.ts' });
    expect(attachments()).toEqual([{ id: expect.any(String), path: 'src/a.ts', label: 'a.ts' }]);
  });

  it('refuses binary files, folders and paths outside the workspace', async () => {
    await controller.handle({ type: 'attachPath', path: 'logo.png' });
    await controller.handle({ type: 'attachPath', path: 'src' });
    await controller.handle({ type: 'attachPath', path: 'escape/notes.md' });
    expect(attachments()).toEqual([]);
    expect(notices()).toEqual([
      'logo.png looks like a binary file. Sovran can attach text files only.',
      'src is not a file.',
      expect.stringMatching(/outside the workspace|escapes/),
    ]);
  });

  it('asks before attaching a protected file', async () => {
    await controller.handle({ type: 'attachPath', path: '.env' });
    expect(h.warnings).toEqual(['Attach .env?']);
    expect(attachments()).toEqual([]);
    h.warningAnswer = 'Attach';
    await controller.handle({ type: 'attachPath', path: '.env' });
    expect(attachments()).toEqual([{ id: expect.any(String), path: '.env', label: '.env' }]);
  });
});

describe('uploadFiles', () => {
  it('attaches files picked outside the workspace as external, and workspace files as usual', async () => {
    h.dialog = [path.join(outside, 'notes.md'), path.join(h.root, 'src/b.ts'), path.join(outside, 'blob.bin')];
    await controller.handle({ type: 'uploadFiles' });
    expect(attachments()).toEqual([
      // `~/…` when the temporary folder is under the home folder (Windows), the full path otherwise.
      { id: expect.any(String), path: displayPath(path.join(outside, 'notes.md'), os.homedir()), label: 'notes.md', external: true },
      { id: expect.any(String), path: 'src/b.ts', label: 'b.ts' },
    ]);
    expect(notices()).toEqual([expect.stringMatching(/blob\.bin looks like a binary file/)]);
  });

  it('does nothing when the dialog is cancelled', async () => {
    await controller.handle({ type: 'uploadFiles' });
    expect(messages).toEqual([]);
  });
});
