import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { workspaceGlob } from '../../src/core/security/globs';
import { isProtectedPath } from '../../src/core/permissions/policy';
import { commandPathRisks } from '../../src/core/permissions/commands';

describe('workspace-controlled path globs', () => {
  it.each([
    ['src/**/*.{ts,tsx}', 'src/nested/file.tsx', true],
    ['src/**/*.{ts,tsx}', 'src/nested/file.js', false],
    ['**/file?.[jt]s', 'src/file1.js', true],
    ['**/file?.[jt]s', 'src/file10.js', false],
    ['**/.*', 'src/.env', true],
    ['app/(auth)/**', 'app/(auth)/page.tsx', true],
    ['app/(auth)/**', 'app/auth/page.tsx', false],
    [String.raw`app/\(auth\)/**`, 'app/(auth)/page.tsx', true],
    ['[(]auth[)]', '(auth)', true],
    ['**/@(a|b).ts', 'src/a.ts', false],
    ['**/@(a|b).ts', 'src/@(a|b).ts', true],
    ['!(secret)', 'public', false],
    ['!(secret)', '!(secret)', true],
    ['(a|b)', 'a', false],
    ['(a|b)', '(a|b)', true],
  ])('matches %s against %s: %s', (pattern, file, expected) => {
    expect(workspaceGlob(pattern)(file)).toBe(expected);
  });

  it('supports exclusion lists without turning literal leading ! into a negation', () => {
    const match = workspaceGlob(['**/*.log', 'app/(auth)/**', '!literal']);
    expect(match('logs/app.log')).toBe(true);
    expect(match('app/(auth)/page.tsx')).toBe(true);
    expect(match('src/index.ts')).toBe(false);
    expect(match('!literal')).toBe(true);
    expect(workspaceGlob([])('anything')).toBe(false);
  });

  it('finishes advisory-shaped patterns in a killable subprocess', { timeout: 15000 }, async () => {
    // Bundle as production CJS so the test also works on Node 20 without native TypeScript support.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-glob-regression-'));
    try {
      const bundle = path.join(directory, 'globs.cjs');
      buildSync({
        entryPoints: [path.resolve('src/core/security/globs.ts')],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        logLevel: 'silent',
      });
      // A regression times out this subprocess, never blocks Vitest's event loop indefinitely.
      const script = `
        const { workspaceGlob } = require(${JSON.stringify(bundle)});
        for (const pattern of ['+(*a)', '+(*)b', '*(a*|b)', '+(ab|abab)', '(a|aa)+']) {
          const match = workspaceGlob(pattern);
          for (const input of ['a'.repeat(40) + '!', 'ab'.repeat(40) + '!']) {
            if (match(input)) throw new Error('Unexpected match');
          }
        }
        console.log('completed');
      `;
      expect(
        execFileSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
      ).toBe('completed');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves advanced user-only protected-path rules for reads and commands', () => {
    const patterns = ['**/@(.env|*.pem)'];
    expect(isProtectedPath('config/.env', patterns)).toBe(true);
    expect(isProtectedPath('certs/server.pem', patterns)).toBe(true);
    expect(isProtectedPath('src/index.ts', patterns)).toBe(false);
    expect(commandPathRisks('cat certs/server.pem', { protectedPaths: patterns })).toEqual([
      'Refers to a protected file (certs/server.pem).',
    ]);
  });
});
