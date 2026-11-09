// Run with the actual minimum Node executable: /path/to/node-20.18.0 scripts/verify-web-runtime.mjs.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'sovran-web-runtime-'));
try {
  await build({
    absWorkingDir: root,
    entryPoints: {
      probe: 'tests/fixtures/webRuntimeProbe.ts',
      webWorker: 'src/extension/adapters/webWorker.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: true,
    outdir: dir,
    logLevel: 'silent',
  });
  const result = spawnSync(process.execPath, [join(dir, 'probe.js'), join(dir, 'webWorker.js')], {
    cwd: dir,
    stdio: 'inherit',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
