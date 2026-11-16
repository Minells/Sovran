// Bundle the development harness outside the VSIX. Real models use the product's normal provider and runner.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'sovran-code-benchmark-'));
try {
  const outfile = join(directory, 'benchmark.cjs');
  await build({
    entryPoints: ['scripts/code-mode-benchmark.mts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });
  const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
