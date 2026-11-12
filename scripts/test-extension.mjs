// Runs smoke tests inside a real VS Code instance (downloads VS Code; use xvfb-run on Linux CI).
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { unzipSync, strFromU8 } from 'fflate';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// A throwaway config file, so the tests never read or write the developer's ~/.sovran. HOME itself must not change:
// the environment applies to the whole VS Code process, and on macOS a HOME without a login keychain blocks VS Code
// at start-up on a system dialog nobody can answer in CI.
const testRoot = mkdtempSync(join(tmpdir(), 'sovran-test-'));
const configFile = join(testRoot, '.sovran', 'config.yaml');
const diagnosticsModule = join(testRoot, 'diagnostics-probe.cjs');
const webModule = join(testRoot, 'web-probe.cjs');
const userData = join(testRoot, 'user-data');
const extensions = join(testRoot, 'extensions');
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
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: process.env.SOVRAN_TEST_VSCODE_VERSION ?? 'stable',
    timeout: 60_000,
  });
  let extensionDevelopmentPath = root;
  const profileArgs = [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`];
  if (process.env.SOVRAN_TEST_VSIX) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true,
    });
    const install = (vsix) =>
      execFileSync(cli, [...args, ...profileArgs, '--install-extension', resolve(vsix), '--force'], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    const installedPath = (vsix = process.env.SOVRAN_TEST_VSIX) => {
      const expected = JSON.parse(
        strFromU8(unzipSync(readFileSync(resolve(vsix)))['extension/package.json']),
      );
      const candidates = readdirSync(extensions).filter((name) => {
        if (!name.startsWith('minells.sovran-')) return false;
        try {
          return (
            JSON.parse(readFileSync(join(extensions, name, 'package.json'), 'utf8')).version ===
            expected.version
          );
        } catch {
          return false;
        }
      });
      if (candidates.length !== 1)
        throw new Error('Expected one installed Sovran artifact in the fresh test profile.');
      return join(extensions, candidates[0]);
    };
    const upgrade = async (phase) =>
      runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: installedPath(
          phase === 'seed' ? process.env.SOVRAN_TEST_UPGRADE_VSIX : process.env.SOVRAN_TEST_VSIX,
        ),
        extensionTestsPath: resolve(root, 'tests/extension/upgrade.cjs'),
        launchArgs: [resolve(root, 'tests/fixtures/workspace'), ...profileArgs, '--disable-extensions'],
        extensionTestsEnv: { SOVRAN_TEST_CONFIG_FILE: configFile, SOVRAN_TEST_UPGRADE_PHASE: phase },
      });
    if (process.env.SOVRAN_TEST_UPGRADE_VSIX) {
      install(process.env.SOVRAN_TEST_UPGRADE_VSIX);
      await upgrade('seed');
    }
    install(process.env.SOVRAN_TEST_VSIX);
    if (process.env.SOVRAN_TEST_UPGRADE_VSIX) await upgrade('verify');
    extensionDevelopmentPath = installedPath();
    // Force Test mode for the installed artifact so config.yaml remains in this throwaway profile.
    const installed = JSON.parse(readFileSync(join(extensionDevelopmentPath, 'package.json'), 'utf8'));
    if (installed.name !== 'sovran') throw new Error('Installed Sovran VSIX was not found.');
  }
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath: resolve(root, 'tests/extension/suite.cjs'),
    launchArgs: [resolve(root, 'tests/fixtures/workspace'), ...profileArgs, '--disable-extensions'],
    extensionTestsEnv: {
      SOVRAN_TEST_CONFIG_FILE: configFile,
      SOVRAN_TEST_DIAGNOSTICS_MODULE: diagnosticsModule,
      SOVRAN_TEST_WEB_MODULE: webModule,
    },
  });
} catch (e) {
  console.error('Extension tests failed:', e);
  process.exitCode = 1;
} finally {
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
