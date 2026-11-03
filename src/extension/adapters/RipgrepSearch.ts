import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { TextSearchOptions, TextSearchResult } from '../../core/ports';

/**
 * Fast workspace text search with ripgrep. Deliberately free of `vscode` imports so it is unit-testable;
 * the host passes the binary path (VS Code ships ripgrep inside its installation).
 */
export class RipgrepSearch {
  constructor(private readonly rgPath: string) {}

  /** Finds VS Code's bundled ripgrep under its app root. */
  static locate(appRoot: string): RipgrepSearch | undefined {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    for (const dir of ['node_modules', 'node_modules.asar.unpacked']) {
      const candidate = path.join(appRoot, dir, '@vscode', 'ripgrep', 'bin', exe);
      if (fs.existsSync(candidate)) return new RipgrepSearch(candidate);
    }
    return undefined;
  }

  search(o: TextSearchOptions, roots: readonly string[]): Promise<TextSearchResult> {
    const args = [
      '--json',
      '--max-filesize',
      '1M',
      '--max-columns',
      '400',
      o.caseSensitive ? '--case-sensitive' : '--ignore-case',
      ...(o.isRegex ? [] : ['--fixed-strings']),
      // Only negative globs are passed to rg: a positive --glob would override .gitignore rules.
      ...o.excludes.flatMap((g) => ['--glob', `!${g}`]),
      '--glob',
      '!**/node_modules/**',
      '--glob',
      '!**/.git/**',
      '--',
      o.query,
      ...roots,
    ];
    const include = o.include && o.include !== '**/*' && o.include !== '**' ? picomatch(o.include, { dot: true }) : undefined;
    const included = (abs: string) =>
      !include || roots.some((r) => {
        const rel = path.relative(r, abs);
        return !rel.startsWith('..') && include(rel.split(path.sep).join('/'));
      });
    return new Promise((resolve, reject) => {
      const child = spawn(this.rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const matches: TextSearchResult['matches'] = [];
      let limitHit = false;
      let buffer = '';
      let stderr = '';
      const stop = () => {
        if (child.exitCode === null) child.kill();
      };
      const onAbort = () => stop();
      o.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (limitHit) continue;
          try {
            const ev = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
            if (ev.type !== 'match' || !ev.data?.path?.text) continue;
            const abs = path.resolve(ev.data.path.text);
            if (!included(abs)) continue;
            matches.push({ path: abs, line: ev.data.line_number ?? 0, text: (ev.data.lines?.text ?? '').replace(/\r?\n$/, '') });
            if (matches.length >= o.maxResults) {
              limitHit = true;
              stop();
            }
          } catch {
            /* ignore partial or non-JSON lines */
          }
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.on('error', (e) => {
        o.signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      child.on('close', (code) => {
        o.signal?.removeEventListener('abort', onAbort);
        // Exit code 1 means "no matches"; 2 is an error unless we stopped it ourselves.
        if (code === 2 && !limitHit && !o.signal?.aborted) {
          reject(new Error(`Search failed: ${stderr.trim().split('\n')[0] ?? 'ripgrep error'}`));
          return;
        }
        resolve({ matches, limitHit });
      });
    });
  }
}
