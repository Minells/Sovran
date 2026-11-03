import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareEntries, displayPath, looksBinary } from '../../src/core/util/files';

describe('looksBinary', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('accepts text, including UTF-8 and an empty file', () => {
    expect(looksBinary(bytes('export const ok = "naïve ✓";\n'))).toBe(false);
    expect(looksBinary(new Uint8Array())).toBe(false);
  });

  it('flags a NUL byte near the start, as Git does', () => {
    expect(looksBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe(true);
  });

  it('only inspects the first 8000 bytes', () => {
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(looksBinary(late)).toBe(false);
    late[7999] = 0;
    expect(looksBinary(late)).toBe(true);
  });
});

describe('displayPath', () => {
  it('shortens paths under the home folder to ~/', () => {
    expect(displayPath('/home/ada/Downloads/spec.md', '/home/ada', path.posix)).toBe('~/Downloads/spec.md');
    expect(displayPath('/home/ada', '/home/ada', path.posix)).toBe('~');
  });

  it('keeps other paths whole, and does not treat a sibling folder as home', () => {
    expect(displayPath('/home/adam/notes.txt', '/home/ada', path.posix)).toBe('/home/adam/notes.txt');
    expect(displayPath('/etc/hosts', undefined, path.posix)).toBe('/etc/hosts');
  });

  it('uses forward slashes on Windows', () => {
    expect(displayPath('C:\\Users\\ada\\Desktop\\a.txt', 'C:\\Users\\ada', path.win32)).toBe('~/Desktop/a.txt');
    expect(displayPath('D:\\data\\b.csv', 'C:\\Users\\ada', path.win32)).toBe('D:/data/b.csv');
  });
});

describe('compareEntries', () => {
  it('puts folders first, then files, in natural case-insensitive order', () => {
    const entries = [
      { name: 'file10.ts', type: 'file' as const },
      { name: 'b', type: 'directory' as const },
      { name: 'File2.ts', type: 'file' as const },
      { name: 'README.md', type: 'file' as const },
      { name: 'A', type: 'directory' as const },
      { name: 'file1.ts', type: 'file' as const },
    ];
    expect([...entries].sort(compareEntries).map((e) => e.name)).toEqual(['A', 'b', 'file1.ts', 'File2.ts', 'file10.ts', 'README.md']);
  });

  it('is deterministic for names that differ only in case', () => {
    const a = { name: 'readme.md', type: 'file' as const };
    const b = { name: 'README.md', type: 'file' as const };
    expect(compareEntries(a, b)).toBe(-compareEntries(b, a));
    expect(compareEntries(a, b)).not.toBe(0);
  });
});
