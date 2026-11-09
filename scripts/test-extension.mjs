// Runs smoke tests inside a real VS Code instance (downloads VS Code; use xvfb-run on Linux CI).
import { runTests } from '@vscode/test-electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// A throwaway config file, so the tests never read or write the developer's ~/.sovran. HOME itself must not change:
// the environment applies to the whole VS Code process, and on macOS a HOME without a login keychain blocks VS Code
// at start-up on a system dialog nobody can answer in CI.
const configFile = join(mkdtempSync(join(tmpdir(), 'sovran-test-')), '.sovran', 'config.yaml');
const diagnosticsModule = join(mkdtempSync(join(tmpdir(), 'sovran-diagnostics-test-')), 'probe.cjs');
const webModule = join(mkdtempSync(join(tmpdir(), 'sovran-web-test-')), 'probe.cjs');
try {
  await build({
    entryPoints: [resolve(root, 'tests/extension/diagnosticsProbe.ts')],
    outfile: diagnosticsModule,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
  });
  await build({
    entryPoints: [resolve(root, 'tests/extension/webProbe.ts')],
    outfile: webModule,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
  });
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, 'tests/extension/suite.cjs'),
    launchArgs: [resolve(root, 'tests/fixtures/workspace'), '--disable-extensions'],
    extensionTestsEnv: { SOVRAN_TEST_CONFIG_FILE: configFile, SOVRAN_TEST_DIAGNOSTICS_MODULE: diagnosticsModule, SOVRAN_TEST_WEB_MODULE: webModule },
  });
} catch (e) {
  console.error('Extension tests failed:', e);
  process.exit(1);
}
