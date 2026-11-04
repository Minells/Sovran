import * as vscode from 'vscode';
import * as path from 'node:path';
import { DiffPresenter } from './adapters/DiffPresenter';
import { FsCheckpointRepository } from './adapters/FsCheckpointRepository';
import { FsSessionRepository, MemorySessionRepository } from './adapters/FsSessionRepository';
import { NodeProcessRunner, TerminalMirror } from './adapters/NodeProcessRunner';
import { RipgrepSearch } from './adapters/RipgrepSearch';
import { VscodeWorkspace } from './adapters/VscodeWorkspace';
import { CommandLoader, FileIndex } from './workspaceServices';
import { readSettings } from './config';
import { ConfigFileHost } from './configFileHost';
import { SovranController } from './SovranController';
import { SovranPanels } from './SovranPanels';
import { SovranViewProvider } from './SovranViewProvider';
import { MementoCapabilityStore, ProviderSecrets, SovranStatusBar, createLogger } from './services';

/** Composition root: wires VS Code adapters into the portable core. */
export async function activate(context: vscode.ExtensionContext) {
  const logger = createLogger();
  const diff = new DiffPresenter();
  const mirror = new TerminalMirror();
  const statusBar = new SovranStatusBar();
  const settings = readSettings();
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const repo = settings.persistSessions ? new FsSessionRepository(path.join(storage, 'sessions')) : new MemorySessionRepository();

  const ripgrep = RipgrepSearch.locate(vscode.env.appRoot);
  logger.info(ripgrep ? 'Using VS Code ripgrep for search.' : 'ripgrep not found; using built-in search.');
  const fileIndex = new FileIndex();
  const commandLoader = new CommandLoader();
  // Smoke tests point the config file at a temporary folder. Only in test mode: normal runs always use
  // ~/.sovran/config.yaml, so nothing in the environment can move it (for example into a repository).
  const testConfigFile = context.extensionMode === vscode.ExtensionMode.Test ? process.env.SOVRAN_TEST_CONFIG_FILE : undefined;
  const configFile = new ConfigFileHost(context.globalState, testConfigFile || undefined);

  // The view provider and the editor tabs need the controller, and the controller needs to reveal and open them.
  const ref: { view?: SovranViewProvider; panels?: SovranPanels } = {};
  const reveal = async () => ref.view?.reveal();

  const controller = new SovranController({
    logger,
    secrets: new ProviderSecrets(context.secrets),
    diff,
    workspace: new VscodeWorkspace(ripgrep),
    process: new NodeProcessRunner(() => (readSettings().mirrorToTerminal ? mirror : undefined)),
    capabilities: new MementoCapabilityStore(context.globalState),
    statusBar,
    repo,
    checkpoints: new FsCheckpointRepository(path.join(storage, 'checkpoints')),
    fileIndex,
    commandLoader,
    configFile,
    reveal,
    openPanel: async (sessionId, title) => ref.panels?.open(sessionId, title),
  });
  await controller.init();
  const viewProvider = new SovranViewProvider(context.extensionUri, controller, logger);
  ref.view = viewProvider;
  // Registers the serializer, so chat tabs from the last session are restored with their chat.
  const panels = new SovranPanels(context.extensionUri, controller, logger);
  ref.panels = panels;

  const command = (id: string, fn: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);
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

export function deactivate() {
  /* disposables are released through context.subscriptions */
}
