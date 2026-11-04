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
    const fs = require('node:fs');
    // scripts/test-extension.mjs points the config file at a temporary folder (honoured only in test mode).
    const file = process.env.SOVRAN_TEST_CONFIG_FILE ?? '';
    assert.ok(file.includes('sovran-test-'), `refusing to touch a real config file: "${file}"`);
    const uri = vscode.Uri.file(file);
    const BAD = 'providers:\n  - id: lab\n    base_url: http://localhost:8000/v1\n';
    const GOOD = 'providers:\n  - id: lab\n    baseUrl: http://localhost:8000/v1\n    auth: none\n    models: [m]\n';
    const diagnostics = () => vscode.languages.getDiagnostics(uri);
    const hinted = () => diagnostics().some((d) => /Did you mean "baseUrl"/.test(d.message) && d.range.start.line === 2);
    const cleared = () => diagnostics().length === 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (check, what, ms = 5000) => {
      for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(100);
      assert.ok(check(), what);
    };

    await vscode.commands.executeCommand('sovran.openConfigFile');
    assert.ok(fs.readFileSync(uri.fsPath, 'utf8').includes('providers:'), 'the template was not created');
    const doc = await vscode.workspace.openTextDocument(uri);

    // The usual flow: edit the file in VS Code and save it.
    const saveInEditor = async (text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
      assert.ok(await vscode.workspace.applyEdit(edit), 'the edit was not applied');
      assert.ok(await doc.save(), 'the file was not saved');
    };
    await saveInEditor(BAD);
    await until(hinted, 'saving in the editor: no diagnostic for base_url');
    await saveInEditor(GOOD);
    await until(cleared, 'saving in the editor: diagnostics were not cleared');

    // Another program changes the file: the file watcher reports it. A watcher registers asynchronously (on Linux
    // it can miss a write made right after it starts), so the write is repeated, as a later save would be, and the
    // number of writes it took is logged.
    const writeOutside = async (text, check, what) => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        fs.writeFileSync(uri.fsPath, text);
        for (let i = 0; i < 10 && !check(); i++) await sleep(100);
        if (check()) return console.log(`    (watcher saw the change after ${attempt} write${attempt === 1 ? '' : 's'})`);
      }
      assert.fail(what);
    };
    await writeOutside(BAD, hinted, 'changed outside VS Code: no diagnostic for base_url');
    await writeOutside(GOOD, cleared, 'changed outside VS Code: diagnostics were not cleared');
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
