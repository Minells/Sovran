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
  'sovran.newChatInEditor',
  'sovran.openInEditor',
  'sovran.acceptProposal',
  'sovran.rejectProposal',
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
    // Chats are named by the model by default (owner decision, ADR-023); the first-words title shows until it arrives.
    assert.strictEqual(cfg.get('sessions.generateTitles'), true);
    assert.deepStrictEqual(cfg.get('mcp.servers'), []);
    // Security-relevant settings ignore workspace values. A repository must never be able to start an MCP server.
    const scope = (key) => ext.packageJSON.contributes.configuration.flatMap((g) => Object.entries(g.properties)).find(([k]) => k === key)?.[1].scope;
    for (const key of [
      'sovran.approvals.mode',
      'sovran.approvals.allowedCommands',
      'sovran.security.protectedPaths',
      'sovran.terminal.mirrorToTerminal',
      'sovran.sessions.generateTitles',
      'sovran.sessions.titleModel',
      'sovran.mcp.servers',
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
  await test('config.yaml and Settings stay in sync both ways, and the file can be ignored', async () => {
    const fs = require('node:fs');
    const file = process.env.SOVRAN_TEST_CONFIG_FILE ?? '';
    assert.ok(file.includes('sovran-test-'), `refusing to touch a real config file: "${file}"`);
    const G = vscode.ConfigurationTarget.Global;
    const cfg = () => vscode.workspace.getConfiguration('sovran');
    const ids = () => (cfg().get('providers') ?? []).map((p) => p.id).sort().join(',');
    const text = () => fs.readFileSync(file, 'utf8');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (check, what, ms = 6000) => {
      for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(100);
      assert.ok(check(), what);
    };
    const local = (id) => ({ id, name: id, baseUrl: 'http://127.0.0.1:9/v1', auth: { type: 'none' }, models: [{ id: 'm' }] });

    // The file wins when it is saved: Settings follow. Wait for something only this content has (the previous test
    // already left a provider "lab" in Settings, so waiting for the id alone would not wait at all).
    const name = () => (cfg().get('providers') ?? []).find((p) => p.id === 'lab')?.name;
    fs.writeFileSync(file, 'providers:\n  # my note\n  - id: lab\n    name: Lab One\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n    models: [m]\n');
    await until(() => ids() === 'lab' && name() === 'Lab One', `Settings did not follow the file (Settings: "${ids()}", name "${name()}")`);

    // Settings change (the panel writes sovran.providers): the file follows and keeps its comments.
    await cfg().update('providers', [...cfg().get('providers'), local('extra')], G);
    await until(() => /id: extra/.test(text()), 'the file did not follow Settings');
    assert.ok(text().includes('# my note'), 'the comment in the file was lost');

    // A repeated event for content already in sync (macOS can deliver late ones, Reload re-reads) changes nothing:
    // Settings keep the provider added above.
    fs.utimesSync(file, new Date(), new Date());
    await sleep(1000);
    assert.strictEqual(ids(), 'extra,lab', `a repeated file event undid a Settings change (Settings: "${ids()}")`);

    // Stop using the file: edits to it no longer reach Settings.
    await cfg().update('configFile.enabled', false, G);
    await sleep(500);
    fs.writeFileSync(file, `${text()}  - id: ghost\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n`);
    await sleep(1500);
    assert.strictEqual(ids(), 'extra,lab', 'an ignored file changed Settings');

    // Use it again: both sides are joined (Settings win where both define a provider).
    await cfg().update('configFile.enabled', undefined, G);
    await until(() => ids() === 'extra,ghost,lab', `the sides were not joined (Settings: "${ids()}")`);
    await until(() => /id: extra/.test(text()) && /id: ghost/.test(text()), 'the file was not joined with Settings');

    await cfg().update('providers', undefined, G);
  });
  await test('view opens, settings open and mode toggles without errors', async () => {
    await vscode.commands.executeCommand('sovran.focus');
    await vscode.commands.executeCommand('sovran.openSettings');
    await vscode.commands.executeCommand('sovran.toggleMode');
    await vscode.commands.executeCommand('sovran.toggleMode');
    await vscode.commands.executeCommand('sovran.newSession');
  });
  await test('chats open in editor tabs, side by side, and close cleanly', async () => {
    const chatTabs = () =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('sovran.chatPanel'));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (check, what, ms = 5000) => {
      for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(100);
      assert.ok(check(), what);
    };
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('sovran.newChatInEditor');
    await until(() => chatTabs().length === 1, 'New Chat in Editor did not open a tab');
    // The view's chat is empty, so "Open Chat in Editor" opens another new chat; tabs stay in one group.
    await vscode.commands.executeCommand('sovran.openInEditor');
    await until(() => chatTabs().length === 2, 'Open Chat in Editor did not open a second tab');
    assert.strictEqual(new Set(vscode.window.tabGroups.all.filter((g) => g.tabs.some((t) => chatTabs().includes(t))).map((g) => g.viewColumn)).size, 1);
    // Tab labels reach the extension host asynchronously (a renderer round trip), so wait for them as for the tabs.
    await until(() => chatTabs().every((t) => t.label === 'New chat'), `unexpected tab titles: ${chatTabs().map((t) => t.label)}`);
    await vscode.window.tabGroups.close(chatTabs());
    await until(() => chatTabs().length === 0, 'chat tabs did not close');
  });
};
