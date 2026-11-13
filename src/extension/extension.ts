import * as vscode from 'vscode';
import * as path from 'node:path';
import { DiffPresenter } from './adapters/DiffPresenter';
import { FsCheckpointRepository } from './adapters/FsCheckpointRepository';
import { FsSessionRepository, MemorySessionRepository } from './adapters/FsSessionRepository';
import { NodeProcessRunner, TerminalMirror } from './adapters/NodeProcessRunner';
import { RipgrepSearch } from './adapters/RipgrepSearch';
import { VscodeWorkspace } from './adapters/VscodeWorkspace';
import { WorkerDocumentConverter } from './adapters/WorkerDocumentConverter';
import { NativeWebFetcher } from './adapters/NativeWebFetcher';
import { WorkerHtmlExtractor } from './adapters/WorkerHtmlExtractor';
import { FsImageStore, MemoryImageStore } from './adapters/FsImageStore';
import { CommandLoader, FileIndex } from './workspaceServices';
import { readSettings } from './config';
import { ConfigFileHost } from './configFileHost';
import { McpHost } from './mcpHost';
import { SovranController } from './SovranController';
import { SovranPanels } from './SovranPanels';
import { SovranViewProvider } from './SovranViewProvider';
import {
  McpSecrets,
  MementoCapabilityStore,
  ProviderSecrets,
  SovranStatusBar,
  createLogger,
} from './services';

/** Stopped on deactivation, which VS Code awaits, so local MCP servers never outlive the window. */
let mcp: McpHost | undefined;

/** Composition root: wires VS Code adapters into the portable core. */
export async function activate(context: vscode.ExtensionContext) {
  const logger = createLogger();
  const diff = new DiffPresenter();
  const mirror = new TerminalMirror();
  const statusBar = new SovranStatusBar();
  const settings = readSettings();
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const repo = settings.persistSessions
    ? new FsSessionRepository(path.join(storage, 'sessions'))
    : new MemorySessionRepository();

  const ripgrep = RipgrepSearch.locate(vscode.env.appRoot);
  logger.info(ripgrep ? 'Using VS Code ripgrep for search.' : 'ripgrep not found; using built-in search.');
  const fileIndex = new FileIndex();
  const commandLoader = new CommandLoader();
  // Smoke tests point the config file at a temporary folder. Only in test mode: normal runs always use
  // ~/.sovran/config.yaml, so nothing in the environment can move it (for example into a repository).
  const testConfigFile =
    context.extensionMode === vscode.ExtensionMode.Test ? process.env.SOVRAN_TEST_CONFIG_FILE : undefined;
  const configFile = new ConfigFileHost(context.globalState, testConfigFile || undefined);

  // The view provider and the editor tabs need the controller, and the controller needs to reveal and open them.
  const ref: { view?: SovranViewProvider; panels?: SovranPanels; controller?: SovranController } = {};
  // MCP servers start in the background: activation never waits for them.
  mcp = new McpHost({
    managed: {
      resources: context.asAbsolutePath('resources/mcp'),
      storage: path.join(context.globalStorageUri.fsPath, 'mcp'),
      remote: !!vscode.env.remoteName,
      host: vscode.env.remoteName
        ? `Remote extension host (${vscode.env.remoteName})`
        : `This computer (${process.platform})`,
    },
    secrets: new McpSecrets(context.secrets),
    logger,
    version: String((context.extension.packageJSON as { version?: unknown }).version ?? '0.0.0'),
    notify: (level, message) => ref.controller?.showNotice(level, message),
  });
  await mcp.init();
  const reveal = async () => ref.view?.reveal();

  const controller = new SovranController({
    logger,
    secrets: new ProviderSecrets(context.secrets),
    diff,
    workspace: new VscodeWorkspace(ripgrep),
    process: new NodeProcessRunner(
      () => (readSettings().mirrorToTerminal ? mirror : undefined),
      () => readSettings().hideSecretVariables,
    ),
    web: new NativeWebFetcher(new WorkerHtmlExtractor(context.asAbsolutePath('dist/webWorker.js'))),
    capabilities: new MementoCapabilityStore(context.globalState),
    statusBar,
    repo,
    checkpoints: new FsCheckpointRepository(path.join(storage, 'checkpoints')),
    fileIndex,
    commandLoader,
    configFile,
    // Bundled next to extension.js by scripts/build-host.mjs; parsers never load in the extension host itself.
    documents: new WorkerDocumentConverter(path.join(context.extensionPath, 'dist', 'documentWorker.js')),
    // Images follow the chats: on disk next to them, or only in memory when chats are not persisted.
    images: settings.persistSessions
      ? new FsImageStore(path.join(storage, 'images'))
      : new MemoryImageStore(),
    mcp,
    reveal,
    openPanel: async (sessionId, title) => ref.panels?.open(sessionId, title),
  });
  ref.controller = controller;
  await controller.init();
  const viewProvider = new SovranViewProvider(context.extensionUri, controller, logger);
  ref.view = viewProvider;
  // Registers the serializer, so chat tabs from the last session are restored with their chat.
  const panels = new SovranPanels(context.extensionUri, controller, logger);
  ref.panels = panels;

  const command = (id: string, fn: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    logger,
    diff,
    mirror,
    fileIndex,
    commandLoader,
    configFile,
    statusBar,
    controller,
    panels,
    vscode.window.registerWebviewViewProvider(SovranViewProvider.viewId, viewProvider),
    command('sovran.focus', () => controller.focus()),
    command('sovran.newSession', async () => {
      await reveal();
      controller.newSession();
    }),
    command('sovran.newChatInEditor', () => controller.openInEditor()),
    command('sovran.openInEditor', () => controller.moveSidebarToEditor()),
    // Editor title buttons pass the diff's URI; the command palette and the keybinding pass nothing.
    command('sovran.acceptProposal', (uri) => controller.decideProposal(true, uri)),
    command('sovran.rejectProposal', (uri) => controller.decideProposal(false, uri)),
    command('sovran.showHistory', async () => {
      controller.showView('history');
      await reveal();
    }),
    command('sovran.manageProviders', async () => {
      controller.showView('providers');
      await reveal();
    }),
    command('sovran.openSettings', async () => {
      controller.showView('settings');
      await reveal();
    }),
    command('sovran.openConfigFile', () => controller.handle({ type: 'openConfigFile' })),
    command('sovran.setApprovalMode', () => controller.pickApprovalMode()),
    command('sovran.selectModel', () => controller.pickModel()),
    command('sovran.setApiKey', () => controller.promptApiKey()),
    command('sovran.toggleMode', () => controller.toggleMode()),
    command('sovran.attachFiles', async () => {
      await controller.focus();
      await controller.attachFiles();
    }),
    command('sovran.askAboutSelection', () => controller.askAboutSelection()),
    command('sovran.cancelRun', () => controller.cancel()),
    command('sovran.compact', () => controller.compactNow()),
    command('sovran.showLogs', () => logger.show()),
  );
  logger.info(`Sovran activated (VS Code ${vscode.version}).`);
}

export async function deactivate() {
  // Other disposables are released through context.subscriptions.
  await mcp?.dispose();
  mcp = undefined;
}
