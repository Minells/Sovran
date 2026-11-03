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
import { SovranController } from './SovranController';
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

  // The view provider needs the controller and the controller needs to reveal the view.
  const ref: { view?: SovranViewProvider } = {};
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
    reveal,
  });
  await controller.init();
  const viewProvider = new SovranViewProvider(context.extensionUri, controller, logger);
  ref.view = viewProvider;

  const command = (id: string, fn: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    logger,
    diff,
    mirror,
    fileIndex,
    commandLoader,
    statusBar,
    controller,
    vscode.window.registerWebviewViewProvider(SovranViewProvider.viewId, viewProvider),
    command('sovran.focus', reveal),
    command('sovran.newSession', async () => {
      await reveal();
      controller.newSession();
    }),
    command('sovran.showHistory', async () => {
      controller.showView('history');
      await reveal();
    }),
    command('sovran.manageProviders', async () => {
      controller.showView('providers');
      await reveal();
    }),
    command('sovran.selectModel', () => controller.pickModel()),
    command('sovran.setApiKey', () => controller.promptApiKey()),
    command('sovran.toggleMode', () => controller.toggleMode()),
    command('sovran.attachFiles', async () => {
      await reveal();
      await controller.attachFiles();
    }),
    command('sovran.askAboutSelection', async () => {
      await reveal();
      await controller.handle({ type: 'setIncludeEditor', value: true });
      controller.focusComposer();
    }),
    command('sovran.cancelRun', () => controller.cancel()),
    command('sovran.compact', () => controller.handle({ type: 'compact' })),
    command('sovran.showLogs', () => logger.show()),
  );
  logger.info(`SOVRAN activated (VS Code ${vscode.version}).`);
}

export function deactivate() {
  /* disposables are released through context.subscriptions */
}
