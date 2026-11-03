// Runs smoke tests inside a real VS Code instance (downloads VS Code; use xvfb-run on Linux CI).
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, 'tests/extension/suite.cjs'),
    launchArgs: [resolve(root, 'tests/fixtures/workspace'), '--disable-extensions'],
  });
} catch (e) {
  console.error('Extension tests failed:', e);
  process.exit(1);
}
