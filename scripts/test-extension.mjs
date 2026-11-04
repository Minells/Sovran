// Runs smoke tests inside a real VS Code instance (downloads VS Code; use xvfb-run on Linux CI).
import { runTests } from '@vscode/test-electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// A throwaway home folder, so the config file tests never read or write the developer's ~/.sovran.
const home = mkdtempSync(join(tmpdir(), 'sovran-home-'));
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, 'tests/extension/suite.cjs'),
    launchArgs: [resolve(root, 'tests/fixtures/workspace'), '--disable-extensions'],
    extensionTestsEnv: { HOME: home, USERPROFILE: home },
  });
} catch (e) {
  console.error('Extension tests failed:', e);
  process.exit(1);
}
