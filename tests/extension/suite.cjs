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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Real VS Code settings, Secret Storage and file notifications cross processes. Shared macOS runners can take
// longer than 6 s even though the sync succeeds. Poll the same state with a bounded CI budget; do not add fixed waits.
const STATE_TIMEOUT_MS = process.env.CI ? 30_000 : 10_000;
async function until(check, what, ms = STATE_TIMEOUT_MS) {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await sleep(100);
  assert.ok(check(), typeof what === 'function' ? what() : what);
}

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
  await test('managed manifests, locks and workers exist in the activated extension', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const asset of [
      'dist/documentWorker.js',
      'dist/webWorker.js',
      'resources/mcp/playwright/package.json',
      'resources/mcp/playwright/package-lock.json',
      'resources/mcp/devtools/package.json',
      'resources/mcp/devtools/package-lock.json',
    ])
      assert.ok(fs.statSync(path.join(ext.extensionPath, asset)).size > 0, asset);
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
    assert.deepStrictEqual(cfg.get('tools.disabled'), []);
    assert.deepStrictEqual(cfg.get('tools.forceAsk'), []);
    // Tools load on demand by default; `all` sends every tool with every request.
    assert.strictEqual(cfg.get('tools.loading'), 'auto');
    // Security-relevant settings ignore workspace values. A repository must never be able to start an MCP server.
    const scope = (key) =>
      ext.packageJSON.contributes.configuration
        .flatMap((g) => Object.entries(g.properties))
        .find(([k]) => k === key)?.[1].scope;
    for (const key of [
      'sovran.approvals.mode',
      'sovran.approvals.allowedCommands',
      'sovran.security.protectedPaths',
      'sovran.terminal.mirrorToTerminal',
      'sovran.sessions.generateTitles',
      'sovran.sessions.titleModel',
      'sovran.mcp.servers',
      'sovran.tools.disabled',
      'sovran.tools.forceAsk',
      'sovran.tools.loading',
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
    const GOOD =
      'providers:\n  - id: lab\n    baseUrl: http://localhost:8000/v1\n    auth: none\n    models: [m]\n';
    const diagnostics = () => vscode.languages.getDiagnostics(uri);
    const hinted = () =>
      diagnostics().some((d) => /Did you mean "baseUrl"/.test(d.message) && d.range.start.line === 2);
    const cleared = () => diagnostics().length === 0;
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
        if (check())
          return console.log(
            `    (watcher saw the change after ${attempt} write${attempt === 1 ? '' : 's'})`,
          );
      }
      assert.fail(what);
    };
    await writeOutside(BAD, hinted, 'changed outside VS Code: no diagnostic for base_url');
    await writeOutside(GOOD, cleared, 'changed outside VS Code: diagnostics were not cleared');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
  await test('native diagnostics read cached Problems for active and unopened files with bounded filtering', async () => {
    const { readDiagnostics } = require(process.env.SOVRAN_TEST_DIAGNOSTICS_MODULE);
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const dir = await fs.mkdtemp(path.join(root, 'sovran-diagnostics-'));
    const active = vscode.Uri.file(path.join(dir, 'active.txt'));
    const unopened = vscode.Uri.file(path.join(dir, 'unopened.txt'));
    const protectedFile = vscode.Uri.file(path.join(dir, '.env'));
    const external = vscode.Uri.file(process.env.SOVRAN_TEST_CONFIG_FILE);
    const virtual = vscode.Uri.parse('sovran-test:/virtual');
    const collection = vscode.languages.createDiagnosticCollection('sovran-smoke');
    const diagnostic = (message, severity) => {
      const d = new vscode.Diagnostic(new vscode.Range(1, 0, 1, 2), message, severity);
      d.source = 'sovran-smoke';
      return d;
    };
    try {
      await Promise.all(
        [active, unopened, protectedFile].map((uri) => fs.writeFile(uri.fsPath, 'one\ntwo\n')),
      );
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(active));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(active, new vscode.Position(0, 0), 'unsaved\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      collection.set(active, [diagnostic('active error', vscode.DiagnosticSeverity.Error)]);
      collection.set(unopened, [
        diagnostic('unopened warning', vscode.DiagnosticSeverity.Warning),
        diagnostic('unopened hint', vscode.DiagnosticSeverity.Hint),
      ]);
      collection.set(protectedFile, [diagnostic('SECRET DIAGNOSTIC', vscode.DiagnosticSeverity.Error)]);
      collection.set(external, [diagnostic('EXTERNAL DIAGNOSTIC', vscode.DiagnosticSeverity.Error)]);
      collection.set(virtual, [diagnostic('VIRTUAL DIAGNOSTIC', vscode.DiagnosticSeverity.Error)]);
      assert.ok(!vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === unopened.fsPath));
      const workspace = await readDiagnostics({});
      assert.ok(workspace.content.includes('unopened warning'), workspace.content);
      assert.ok(!/SECRET DIAGNOSTIC|EXTERNAL DIAGNOSTIC|VIRTUAL DIAGNOSTIC/.test(workspace.content));
      const activeResult = await readDiagnostics({ scope: 'active' });
      assert.ok(activeResult.content.includes('active error'));
      assert.ok(!activeResult.content.includes('unopened warning'));
      const filtered = await readDiagnostics({ path: dir, severity: 'warning' });
      assert.ok(filtered.content.includes('unopened warning'));
      assert.ok(!/active error|unopened hint/.test(filtered.content));
      assert.strictEqual(
        (await readDiagnostics({ path: unopened.fsPath, severity: 'hint' })).summary,
        '1 cached diagnostic(s)',
      );
      assert.ok((await readDiagnostics({ path: dir, max_results: 1 })).content.includes('Results limited'));
      assert.ok(
        !vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === unopened.fsPath),
        'the tool opened a document',
      );
      collection.clear();
      assert.ok((await readDiagnostics({ path: dir })).content.includes('No matching cached diagnostics'));
    } finally {
      collection.dispose();
      // Discard the disposable buffer rather than saving it into the fixture workspace.
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      // Windows may still hold the workspace directory briefly after closing its editor.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
  await test('native Web adapters load the packaged worker and read only the controlled fixture', async () => {
    const http = require('node:http');
    const path = require('node:path');
    const { readWeb } = require(process.env.SOVRAN_TEST_WEB_MODULE);
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url === '/robots.txt')
        return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /');
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<title>Smoke docs</title><main><h1>Read me</h1><pre>const x = 1;</pre><a href="/api">API</a></main>',
        );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { prepared, result } = await readWeb(
        path.join(ext.extensionPath, 'dist', 'webWorker.js'),
        server.address().port,
      );
      assert.deepStrictEqual(prepared.approval, { kind: 'web', url: 'https://docs.example.com/guide' });
      assert.ok(result.content.includes('Smoke docs'));
      assert.ok(result.content.includes('# Read me'));
      assert.ok(result.content.includes('const x = 1;'));
      assert.equal(result.content.split('\n\nLinks:\n').at(-1), '- https://docs.example.com/api');
      assert.ok(result.content.length <= 2000);
      assert.deepStrictEqual(seen, ['/robots.txt', '/guide']);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  await test('config.yaml and Settings stay in sync both ways, and the file can be ignored', async () => {
    const fs = require('node:fs');
    const file = process.env.SOVRAN_TEST_CONFIG_FILE ?? '';
    assert.ok(file.includes('sovran-test-'), `refusing to touch a real config file: "${file}"`);
    const G = vscode.ConfigurationTarget.Global;
    const cfg = () => vscode.workspace.getConfiguration('sovran');
    const ids = () =>
      (cfg().get('providers') ?? [])
        .map((p) => p.id)
        .sort()
        .join(',');
    const text = () => fs.readFileSync(file, 'utf8');
    // Only this disposable fixture is included in failures; never dump a developer's real settings or config file.
    const syncState = () =>
      JSON.stringify({
        providers: cfg().get('providers'),
        enabled: cfg().get('configFile.enabled'),
        file: text(),
        documents: vscode.workspace.textDocuments
          .filter((doc) => doc.uri.fsPath === file)
          .map((doc) => ({ dirty: doc.isDirty, version: doc.version })),
      });
    const local = (id) => ({
      id,
      name: id,
      baseUrl: 'http://127.0.0.1:9/v1',
      auth: { type: 'none' },
      models: [{ id: 'm' }],
    });

    // The file wins when it is saved: Settings follow. Wait for something only this content has (the previous test
    // already left a provider "lab" in Settings, so waiting for the id alone would not wait at all).
    const name = () => (cfg().get('providers') ?? []).find((p) => p.id === 'lab')?.name;
    fs.writeFileSync(
      file,
      'providers:\n  # my note\n  - id: lab\n    name: Lab One\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n    models: [m]\n',
    );
    await until(
      () => ids() === 'lab' && name() === 'Lab One',
      () => `Settings did not follow the file: ${syncState()}`,
    );

    // Settings change (the panel writes sovran.providers): the file follows and keeps its comments.
    await cfg().update('providers', [...cfg().get('providers'), local('extra')], G);
    await until(
      () => /id: extra/.test(text()),
      () => `the file did not follow Settings: ${syncState()}`,
    );
    assert.ok(text().includes('# my note'), 'the comment in the file was lost');

    // A repeated event for content already in sync (macOS can deliver late ones, Reload re-reads) changes nothing:
    // Settings keep the provider added above.
    fs.utimesSync(file, new Date(), new Date());
    await sleep(1000);
    assert.strictEqual(
      ids(),
      'extra,lab',
      `a repeated file event undid a Settings change (Settings: "${ids()}")`,
    );

    // Stop using the file: edits to it no longer reach Settings.
    await cfg().update('configFile.enabled', false, G);
    await sleep(500);
    fs.writeFileSync(file, `${text()}  - id: ghost\n    baseUrl: http://127.0.0.1:9/v1\n    auth: none\n`);
    await sleep(1500);
    assert.strictEqual(ids(), 'extra,lab', 'an ignored file changed Settings');

    // Use it again: both sides are joined (Settings win where both define a provider).
    await cfg().update('configFile.enabled', undefined, G);
    await until(
      () => ids() === 'extra,ghost,lab',
      () => `the sides were not joined: ${syncState()}`,
    );
    await until(
      () => /id: extra/.test(text()) && /id: ghost/.test(text()),
      () => `the file was not joined with Settings: ${syncState()}`,
    );

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
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter(
          (t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('sovran.chatPanel'),
        );
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('sovran.newChatInEditor');
    await until(() => chatTabs().length === 1, 'New Chat in Editor did not open a tab');
    // The view's chat is empty, so "Open Chat in Editor" opens another new chat; tabs stay in one group.
    await vscode.commands.executeCommand('sovran.openInEditor');
    await until(() => chatTabs().length === 2, 'Open Chat in Editor did not open a second tab');
    assert.strictEqual(
      new Set(
        vscode.window.tabGroups.all
          .filter((g) => g.tabs.some((t) => chatTabs().includes(t)))
          .map((g) => g.viewColumn),
      ).size,
      1,
    );
    // Tab labels reach the extension host asynchronously (a renderer round trip), so wait for them as for the tabs.
    await until(
      () => chatTabs().every((t) => t.label === 'New chat'),
      `unexpected tab titles: ${chatTabs().map((t) => t.label)}`,
    );
    await vscode.window.tabGroups.close(chatTabs());
    await until(() => chatTabs().length === 0, 'chat tabs did not close');
  });
};
