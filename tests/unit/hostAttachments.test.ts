/**
 * Host side of the attach menu, on a real folder: listing, suggestions, attaching and uploading. The VS Code API is a
 * small in-memory stand-in; file-system checks (realpath, binary detection) run for real.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertDocument } from '../../src/core/documents/convert';
import type { DirEntry, DocumentConverterPort, FileStat, WorkspaceRoot } from '../../src/core/ports';
import type { ContextAttachment } from '../../src/core/sessions/model';
import { displayPath } from '../../src/core/util/files';
import type { HostMessage } from '../../src/shared/protocol';
import { makeDocx, makePdf, wp } from '../fixtures/documents';
import { makeJpeg, makePng } from '../fixtures/images';
import type { ImageAttachment } from '../../src/core/sessions/model';

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
      withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
    },
    ProgressLocation: { Window: 10 },
  };
});

const { SovranController } = await import('../../src/extension/SovranController');
const { FileIndex } = await import('../../src/extension/workspaceServices');
const { MemoryImageStore } = await import('../../src/extension/adapters/FsImageStore');
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
/** The conversions the controller asked for. The tests convert in-process; the extension uses the worker. */
let conversions: string[];
const documents: DocumentConverterPort = {
  convert: async (data, options) => {
    conversions.push(new TextDecoder().decode(data.subarray(0, 5)));
    return convertDocument(data, options);
  },
};
/** What the next message would carry: the controller's own send-time read of the sidebar's attachments. */
const collect = () => {
  const c = controller as unknown as { sidebar: unknown; collectAttachments(s: unknown): Promise<ContextAttachment[]> };
  return c.collectAttachments(c.sidebar);
};
/** The images the next message would carry, stored for chat `s1`. */
const collectImages = () => {
  const c = controller as unknown as { sidebar: unknown; collectImages(s: unknown, id: string): Promise<ImageAttachment[]> };
  return c.collectImages(c.sidebar, 's1');
};
let store: InstanceType<typeof MemoryImageStore>;
const base64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

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
  await write('logo.png', makePng(64, 32));
  await write('node_modules/dep/index.js', '');
  await write('.git/HEAD', 'ref: refs/heads/main\n');
  await write('notes.md', '# notes from elsewhere\n', outside);
  await write('blob.bin', Uint8Array.from([0, 1, 2, 3]), outside);
  // A junction on Windows needs no extra privilege; other platforms ignore the type and create a symbolic link.
  await fs.symlink(outside, path.join(h.root, 'escape'), 'junction');

  messages = [];
  conversions = [];
  controller = new SovranController({
    workspace: new DiskWorkspace(),
    fileIndex: new FileIndex(),
    documents,
    images: (store = new MemoryImageStore()),
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
    await write('scan.bmp', Uint8Array.from([0x42, 0x4d, 0x36, 0, 0, 0, 0, 0]));
    await write('tool.bin', Uint8Array.from([0, 1, 2, 3]));
    await controller.handle({ type: 'attachPath', path: 'scan.bmp' });
    await controller.handle({ type: 'attachPath', path: 'tool.bin' });
    await controller.handle({ type: 'attachPath', path: 'src' });
    await controller.handle({ type: 'attachPath', path: 'escape/notes.md' });
    expect(attachments()).toEqual([]);
    expect(notices()).toEqual([
      'scan.bmp is an image in a format models do not accept. Save it as PNG or JPEG, then attach that.',
      expect.stringMatching(/^tool\.bin looks like a binary file\./),
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

describe('documents', () => {
  it('attaches a PDF as a document and sends its text with what it is', async () => {
    await write('docs/spec.pdf', makePdf([['Requisiti del sistema'], ['Allegato A']]));
    await controller.handle({ type: 'attachPath', path: 'docs/spec.pdf' });
    expect(attachments()).toEqual([{ id: expect.any(String), path: 'docs/spec.pdf', label: 'spec.pdf', format: 'pdf', detail: '2 pages' }]);
    expect(await collect()).toEqual([
      { kind: 'file', path: 'docs/spec.pdf', format: 'pdf', detail: '2 pages', content: '## Page 1\n\nRequisiti del sistema\n\n## Page 2\n\nAllegato A' },
    ]);
    // The send reused the conversion made when the file was attached.
    expect(conversions).toHaveLength(1);
  });

  it('converts a document again only when it changed', async () => {
    const file = await write('report.docx', makeDocx(wp('Prima versione')));
    await controller.handle({ type: 'attachPath', path: 'report.docx' });
    expect((await collect())[0]?.content).toBe('Prima versione');
    expect(conversions).toHaveLength(1);
    await fs.writeFile(file, makeDocx(wp('Seconda versione, più lunga')));
    expect((await collect())[0]).toMatchObject({ format: 'docx', content: 'Seconda versione, più lunga' });
    expect(conversions).toHaveLength(2);
  });

  it('recognizes a document by its content, not its name', async () => {
    await write('renamed.bin', makeDocx(wp('Contenuto')));
    await controller.handle({ type: 'attachPath', path: 'renamed.bin' });
    expect(attachments()).toEqual([expect.objectContaining({ path: 'renamed.bin', format: 'docx' })]);
  });

  it('says why a document cannot be read', async () => {
    await write('scan.pdf', makePdf([[]]));
    await write('broken.docx', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2, 3]));
    await controller.handle({ type: 'attachPath', path: 'scan.pdf' });
    await controller.handle({ type: 'attachPath', path: 'broken.docx' });
    expect(attachments()).toEqual([]);
    expect(notices()).toEqual([
      'scan.pdf has no text to read: it is probably a scanned image. Attach a PDF with selectable text, or paste the text you need.',
      'broken.docx could not be read as a document: the file may be damaged.',
    ]);
  });

  it('still attaches as text a text file that only looks like a PDF', async () => {
    await write('notes/pdf-header.md', '%PDF- is how every PDF starts.\n');
    await controller.handle({ type: 'attachPath', path: 'notes/pdf-header.md' });
    expect(attachments()).toEqual([{ id: expect.any(String), path: 'notes/pdf-header.md', label: 'pdf-header.md' }]);
    expect(await collect()).toEqual([{ kind: 'file', path: 'notes/pdf-header.md', content: '%PDF- is how every PDF starts.\n' }]);
  });

  it('attaches UTF-16 text (Windows PowerShell output) decoded', async () => {
    const text = 'Name  Status\r\nsvc   Running\r\n';
    await write('out.txt', Uint8Array.from([0xff, 0xfe, ...Buffer.from(text, 'utf16le')]));
    await controller.handle({ type: 'attachPath', path: 'out.txt' });
    expect(attachments()).toEqual([{ id: expect.any(String), path: 'out.txt', label: 'out.txt' }]);
    expect(await collect()).toEqual([{ kind: 'file', path: 'out.txt', content: text }]);
  });

  it('asks before reading a protected document, and reads nothing when declined', async () => {
    // A PDF under a protected name (`**/*.pem` in this workspace): the signature decides what it is.
    await write('keys/cert.pem', makePdf([['Riservato']]));
    await controller.handle({ type: 'attachPath', path: 'keys/cert.pem' });
    expect(h.warnings).toEqual(['Attach cert.pem?']);
    expect(conversions).toEqual([]);
    expect(attachments()).toEqual([]);
    h.warningAnswer = 'Attach';
    await controller.handle({ type: 'attachPath', path: 'keys/cert.pem' });
    expect(conversions).toHaveLength(1);
    expect(attachments()).toEqual([expect.objectContaining({ path: 'keys/cert.pem', format: 'pdf' })]);
  });

  it('attaches documents picked from the computer, and checks them again when sending', async () => {
    const file = path.join(outside, 'budget.pdf');
    await write('budget.pdf', makePdf([['Budget 2026']]), outside);
    h.dialog = [file];
    await controller.handle({ type: 'uploadFiles' });
    const shown = displayPath(file, os.homedir());
    expect(attachments()).toEqual([{ id: expect.any(String), path: shown, label: 'budget.pdf', external: true, format: 'pdf', detail: '1 page' }]);
    expect(await collect()).toEqual([{ kind: 'file', path: shown, external: true, format: 'pdf', detail: '1 page', content: '## Page 1\n\nBudget 2026' }]);
    // Replaced by an image after it was attached: the send leaves it out and says why.
    await fs.writeFile(file, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
    expect(await collect()).toEqual([]);
    expect(notices().at(-1)).toBe(`${shown} is now an image. Attach it again to send it as one.`);
  });
});

describe('images', () => {
  it('attaches a workspace image with its size and stores it when the message is sent', async () => {
    await controller.handle({ type: 'attachPath', path: 'logo.png' });
    expect(attachments()).toEqual([{ id: expect.any(String), path: 'logo.png', label: 'logo.png', image: { mime: 'image/png', width: 64, height: 32 } }]);
    // Images travel apart from the text context.
    expect(await collect()).toEqual([]);
    const [image] = await collectImages();
    expect(image).toEqual({ id: expect.stringMatching(/^[a-f0-9]{64}$/), name: 'logo.png', source: 'workspace', mime: 'image/png', bytes: makePng(64, 32).length, width: 64, height: 32 });
    expect(await store.load('s1', image!.id)).toEqual(makePng(64, 32));
  });

  it('attaches pasted images once each, named in order', async () => {
    await controller.handle({ type: 'attachImage', data: base64(makePng(10, 10, 1)) });
    await controller.handle({ type: 'attachImage', data: base64(makePng(10, 10, 1)) });
    await controller.handle({ type: 'attachImage', data: base64(makeJpeg(1920, 1080)) });
    expect(attachments()).toEqual([
      { id: expect.any(String), path: 'Pasted image 1', label: 'Pasted image 1', image: { mime: 'image/png', width: 10, height: 10, pasted: true } },
      { id: expect.any(String), path: 'Pasted image 2', label: 'Pasted image 2', image: { mime: 'image/jpeg', width: 1920, height: 1080, pasted: true } },
    ]);
    expect((await collectImages()).map((i) => [i.name, i.source, i.mime])).toEqual([
      ['Pasted image 1', 'pasted', 'image/png'],
      ['Pasted image 2', 'pasted', 'image/jpeg'],
    ]);
  });

  it('refuses a paste that is not an image, and more images than a message can carry', async () => {
    await controller.handle({ type: 'attachImage', data: base64(new TextEncoder().encode('not an image at all')) });
    expect(notices()).toEqual(['The pasted content is not an image Sovran can send. Paste a PNG, JPEG, WebP or GIF image.']);
    for (let i = 0; i < 9; i++) await controller.handle({ type: 'attachImage', data: base64(makePng(4, 4, i)) });
    expect(attachments()).toHaveLength(8);
    expect(notices().at(-1)).toBe('A message can carry up to 8 images. Send these first, then attach more.');
  });

  it('leaves out an image that is no longer one when the message is sent', async () => {
    const file = await write('shot.png', makePng(8, 8));
    await controller.handle({ type: 'attachPath', path: 'shot.png' });
    await fs.writeFile(file, 'now it is text');
    expect(await collectImages()).toEqual([]);
    expect(notices().at(-1)).toBe('shot.png is no longer an image, so it was not attached.');
  });
});
