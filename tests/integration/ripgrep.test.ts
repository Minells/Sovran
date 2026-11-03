import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RipgrepSearch } from '../../src/extension/adapters/RipgrepSearch';

function findRg(): string | undefined {
  try {
    return execSync(process.platform === 'win32' ? 'where rg' : 'command -v rg', { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const rg = findRg();
let dir = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovran-rg-'));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  write('src/a.ts', 'export const TOKEN = 1;\nconst x = TOKEN + 1;\n');
  write('src/b.py', 'token = "a.b"\n');
  write('.env', 'TOKEN=supersecret\n');
  write('node_modules/lib/index.js', 'TOKEN\n');
  write('ignored/out.ts', 'TOKEN\n');
  write('.gitignore', 'ignored/\n');
  fs.mkdirSync(path.join(dir, '.git')); // ripgrep honors .gitignore inside git repositories
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!rg)('RipgrepSearch (system rg)', () => {
  const search = (o: Partial<Parameters<RipgrepSearch['search']>[0]>) =>
    new RipgrepSearch(rg!).search({ query: 'TOKEN', isRegex: false, caseSensitive: true, include: '**/*', excludes: ['**/.env'], maxResults: 100, ...o }, [dir]);

  it('finds matches with absolute paths and line numbers, honoring excludes, node_modules and .gitignore', async () => {
    const r = await search({});
    const rel = r.matches.map((m) => `${path.relative(dir, m.path).split(path.sep).join('/')}:${m.line}`).sort();
    expect(rel).toEqual(['src/a.ts:1', 'src/a.ts:2']);
  });

  it('supports case-insensitive literal search and include globs', async () => {
    const r = await search({ caseSensitive: false, include: '**/*.py', query: 'a.b' });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.text).toBe('token = "a.b"');
  });

  it('stops at maxResults', async () => {
    const r = await search({ maxResults: 1 });
    expect(r.matches).toHaveLength(1);
    expect(r.limitHit).toBe(true);
  });

  it('reports regex errors', async () => {
    await expect(search({ isRegex: true, query: '(' })).rejects.toThrow(/Search failed/);
  });
});
