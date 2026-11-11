// Runs before/after replacing an installed VSIX in the same throwaway VS Code profile.
const assert = require('node:assert/strict');
const vscode = require('vscode');
const values = {
  'tools.disabled': ['execute_terminal'],
  'tools.forceAsk': ['read_file'],
  'mcp.servers': [
    {
      id: 'upgrade-custom',
      command: 'sovran-test-never-start',
      enabled: false,
      allowedTools: ['read'],
      disabledTools: ['write'],
    },
    {
      id: 'upgrade-browser',
      command: 'node',
      enabled: false,
      managed: { id: 'playwright', version: '0.0.84', profile: 'isolated' },
    },
  ],
};
exports.run = async () => {
  const ext = vscode.extensions.all.find((item) => item.packageJSON.name === 'sovran');
  assert.ok(ext);
  await ext.activate();
  const config = vscode.workspace.getConfiguration('sovran');
  if (process.env.SOVRAN_TEST_UPGRADE_PHASE === 'seed') {
    for (const [key, value] of Object.entries(values))
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    console.log(
      '  ✓ previous installed VSIX activated and saved disconnected integrations and native overrides',
    );
  } else {
    for (const [key, value] of Object.entries(values))
      assert.deepEqual(config.get(key), value, `Upgrade changed ${key}`);
    console.log(
      '  ✓ installed replacement preserved server ids, profiles, enabled flags and Off/Allow/native overrides',
    );
    for (const key of Object.keys(values))
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
};
