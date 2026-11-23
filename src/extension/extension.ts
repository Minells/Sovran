import * as vscode from 'vscode';
import * as path from 'node:path';
import { DiffPresenter } from './adapters/DiffPresenter';
import { FsCheckpointRepository, SwitchingCheckpointRepository } from './adapters/FsCheckpointRepository';
import {
  FsSessionRepository,
  MemorySessionRepository,
  SwitchingSessionRepository,
} from './adapters/FsSessionRepository';
import { NodeProcessRunner, TerminalMirror } from './adapters/NodeProcessRunner';
import { RipgrepSearch } from './adapters/RipgrepSearch';
import { VscodeWorkspace } from './adapters/VscodeWorkspace';
import { WorkerDocumentConverter } from './adapters/WorkerDocumentConverter';
import { NativeWebFetcher } from './adapters/NativeWebFetcher';
import { WorkerHtmlExtractor } from './adapters/WorkerHtmlExtractor';
import { FsImageStore, MemoryImageStore, SwitchingImageStore } from './adapters/FsImageStore';
import { CommandLoader, FileIndex } from './workspaceServices';
import { readSettings } from './config';
import { ConfigFileHost } from './configFileHost';
import { McpHost } from './mcpHost';
import { SovranController } from './SovranController';
import { SovranInlineCompletionProvider } from './InlineCompletionProvider';
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

/** Register editor functionality immediately. Start the chat host when a chat surface or command needs it. */
export function activate(context: vscode.ExtensionContext) {
  const logger = createLogger();
  const secrets = new ProviderSecrets(context.secrets);
  const inline = new SovranInlineCompletionProvider(new VscodeWorkspace(), secrets, logger);
  let chat: ReturnType<typeof activateChat> | undefined;
  const getChat = (): ReturnType<typeof activateChat> =>
    (chat ??= activateChat(context, logger, secrets, () => view.reveal()));
  const view = new SovranViewProvider(context.extensionUri, async () => (await getChat()).controller, logger);
  const command = (id: string, fn: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);
  const chatCommand = (id: string, fn: (controller: SovranController, ...args: unknown[]) => unknown) =>
    command(id, async (...args) => fn((await getChat()).controller, ...args));

  context.subscriptions.push(
    logger,
    inline,
    vscode.window.registerWebviewViewProvider(SovranViewProvider.viewId, view),
    vscode.window.registerWebviewPanelSerializer(SovranPanels.viewType, {
      async deserializeWebviewPanel(panel, state) {
        await (await getChat()).panels.deserializeWebviewPanel(panel, state);
      },
    }),
    chatCommand('sovran.focus', (controller) => controller.focus()),
    chatCommand('sovran.newSession', async (controller) => {
      await view.reveal();
      controller.newSession();
    }),
    chatCommand('sovran.newChatInEditor', (controller) => controller.openInEditor()),
    chatCommand('sovran.openInEditor', (controller) => controller.moveSidebarToEditor()),
    // Editor title buttons pass the diff's URI; the command palette and the keybinding pass nothing.
    chatCommand('sovran.acceptProposal', (controller, uri) => controller.decideProposal(true, uri)),
    chatCommand('sovran.rejectProposal', (controller, uri) => controller.decideProposal(false, uri)),
    chatCommand('sovran.showHistory', async (controller) => {
      controller.showView('history');
      await view.reveal();
    }),
    chatCommand('sovran.manageProviders', async (controller) => {
      controller.showView('providers');
      await view.reveal();
    }),
    chatCommand('sovran.openSettings', async (controller) => {
      controller.showView('settings');
      await view.reveal();
    }),
    chatCommand('sovran.openConfigFile', (controller) => controller.handle({ type: 'openConfigFile' })),
    chatCommand('sovran.setApprovalMode', (controller) => controller.pickApprovalMode()),
    chatCommand('sovran.selectModel', (controller) => controller.pickModel()),
    chatCommand('sovran.setApiKey', (controller) => controller.promptApiKey()),
    chatCommand('sovran.toggleMode', (controller) => controller.toggleMode()),
    chatCommand('sovran.attachFiles', async (controller) => {
      await controller.focus();
      await controller.attachFiles();
    }),
    chatCommand('sovran.askAboutSelection', (controller) => controller.askAboutSelection()),
    chatCommand('sovran.cancelRun', (controller) => controller.cancel()),
    chatCommand('sovran.compact', (controller) => controller.compactNow()),
    command('sovran.showLogs', () => logger.show()),
    command('sovran.triggerInlineCompletion', () => inline.trigger()),
  );
  logger.info(`Sovran activated (VS Code ${vscode.version}).`);
}

async function activateChat(
  context: vscode.ExtensionContext,
  logger: ReturnType<typeof createLogger>,
  secrets: ProviderSecrets,
  reveal: () => Promise<void>,
) {
  const diff = new DiffPresenter();
  const mirror = new TerminalMirror();
  const statusBar = new SovranStatusBar();
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  // Both are read for every save, so turning `sovran.sessions.persist` off stops writing chats at once.
  const persistSessions = () => readSettings().persistSessions;
  const repo = new SwitchingSessionRepository(
    new FsSessionRepository(path.join(storage, 'sessions')),
    new MemorySessionRepository(),
    persistSessions,
  );

  const ripgrep = RipgrepSearch.locate(vscode.env.appRoot);
  logger.info(ripgrep ? 'Using VS Code ripgrep for search.' : 'ripgrep not found; using built-in search.');
  const fileIndex = new FileIndex();
  const commandLoader = new CommandLoader();
  // Smoke tests point the config file at a temporary folder. Only in test mode: normal runs always use
  // ~/.sovran/config.yaml, so nothing in the environment can move it (for example into a repository).
  const testConfigFile =
    context.extensionMode === vscode.ExtensionMode.Test ? process.env.SOVRAN_TEST_CONFIG_FILE : undefined;
  const configFile = new ConfigFileHost(context.globalState, testConfigFile || undefined);

  const ref: { panels?: SovranPanels; controller?: SovranController } = {};
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
  const controller = new SovranController({
    logger,
    secrets,
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
    checkpoints: new SwitchingCheckpointRepository(
      new FsCheckpointRepository(path.join(storage, 'checkpoints')),
      persistSessions,
    ),
    fileIndex,
    commandLoader,
    configFile,
    // Bundled next to extension.js by scripts/build-host.mjs; parsers never load in the extension host itself.
    documents: new WorkerDocumentConverter(path.join(context.extensionPath, 'dist', 'documentWorker.js')),
    // Images follow the chats: on disk next to them, or only in memory when chats are not persisted.
    images: new SwitchingImageStore(new FsImageStore(path.join(storage, 'images')), new MemoryImageStore(), persistSessions),
    mcp,
    reveal,
    openPanel: async (sessionId, title) => ref.panels?.open(sessionId, title),
  });
  ref.controller = controller;
  await controller.init();
  const panels = new SovranPanels(context.extensionUri, controller, logger);
  ref.panels = panels;
  context.subscriptions.push(diff, mirror, fileIndex, commandLoader, configFile, statusBar, controller);
  return { controller, panels };
}

export async function deactivate() {
  // Other disposables are released through context.subscriptions.
  await mcp?.dispose();
  mcp = undefined;
}
