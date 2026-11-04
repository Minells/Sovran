// Smoke tests executed inside the VS Code extension host by scripts/test-extension.mjs.
const assert = require('node:assert');
const vscode = require('vscode');

const COMMANDS = [
  'sovran.newSession',
  'sovran.showHistory',
  'sovran.openSettings',
  'sovran.manageProviders',
  'sovran.openConfigFile',
  'sovran.selectModel',
  'sovran.setApiKey',
  'sovran.toggleMode',
  'sovran.setApprovalMode',
  'sovran.focus',
  'sovran.askAboutSelection',
  'sovran.attachFiles',
  'sovran.cancelRun',
  'sovran.showLogs',
  'sovran.compact',
];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'sovran');
  await test('extension is present and activates', async () => {
    assert.ok(ext, 'Sovran extension not found');
    await ext.activate();
    assert.ok(ext.isActive);
  });
  await test('all commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of COMMANDS) assert.ok(all.includes(c), `missing command ${c}`);
  });
  await test('secure defaults', async () => {
    const cfg = vscode.workspace.getConfiguration('sovran');
    assert.deepStrictEqual(cfg.get('providers'), []);
    assert.strictEqual(cfg.get('approvals.mode'), 'ask');
    assert.strictEqual(cfg.get('approvals.fileEdits'), 'ask');
    assert.deepStrictEqual(cfg.get('approvals.allowedCommands'), []);
    assert.ok(cfg.get('security.protectedPaths').includes('**/.env'));
    // Naming chats with the model sends the first message in an extra request: off unless the user turns it on.
    assert.strictEqual(cfg.get('sessions.generateTitles'), false);
    // Security-relevant settings ignore workspace values.
    const scope = (key) => ext.packageJSON.contributes.configuration.flatMap((g) => Object.entries(g.properties)).find(([k]) => k === key)?.[1].scope;
    for (const key of [
      'sovran.approvals.mode',
      'sovran.approvals.allowedCommands',
      'sovran.security.protectedPaths',
      'sovran.terminal.mirrorToTerminal',
      'sovran.sessions.generateTitles',
      'sovran.sessions.titleModel',
    ]) {
      assert.strictEqual(scope(key), 'application', `${key} must be application-scoped`);
    }
  });
  await test('config.yaml problems show in the editor and clear once the file is fixed', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    // scripts/test-extension.mjs points HOME at a temporary folder.
    assert.ok(os.homedir().includes('sovran-home-'), `refusing to touch a real home folder: ${os.homedir()}`);
    const uri = vscode.Uri.file(path.join(os.homedir(), '.sovran', 'config.yaml'));
    await vscode.commands.executeCommand('sovran.openConfigFile');
    assert.ok(fs.readFileSync(uri.fsPath, 'utf8').includes('providers:'), 'the template was not created');
    const diagnostics = () => vscode.languages.getDiagnostics(uri);
    const until = async (check, what) => {
      for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(check(), what);
    };
    fs.writeFileSync(uri.fsPath, 'providers:\n  - id: lab\n    base_url: http://localhost:8000/v1\n');
    await vscode.commands.executeCommand('sovran.openConfigFile');
    await until(() => diagnostics().some((d) => /Did you mean "baseUrl"/.test(d.message) && d.range.start.line === 2), 'no diagnostic for base_url');
    fs.writeFileSync(uri.fsPath, 'providers:\n  - id: lab\n    baseUrl: http://localhost:8000/v1\n    auth: none\n    models: [m]\n');
    await until(() => diagnostics().length === 0, 'diagnostics were not cleared');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  await test('view opens, settings open and mode toggles without errors', async () => {
    await vscode.commands.executeCommand('sovran.focus');
    await vscode.commands.executeCommand('sovran.openSettings');
    await vscode.commands.executeCommand('sovran.toggleMode');
    await vscode.commands.executeCommand('sovran.toggleMode');
    await vscode.commands.executeCommand('sovran.newSession');
  });
};
