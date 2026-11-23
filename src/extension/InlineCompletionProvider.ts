import * as vscode from 'vscode';
import { automaticFile } from '../core/context/targetedContext';
import { INFILL_LIMITS, InfillRequests, infillEndpoint, requestInfill } from '../core/providers/infill';
import { normalizeApiKey } from '../core/providers/connection';
import { readAutocompleteEnabled, readAutocompleteModel, readProviders, readSettings } from './config';
import type { VscodeWorkspace } from './adapters/VscodeWorkspace';
import { excludesWorkspaceFile } from './workspaceFilePolicy';
import type { HostLogger, ProviderSecrets } from './services';

function selectedProvider() {
  const [id, ...parts] = readAutocompleteModel().split('/');
  const model = parts.join('/');
  if (!id || !model) return undefined;
  const config = readProviders().find((p) => p.id === id);
  if (!config || !config.models?.some((m) => m.id === model && m.fim === 'llama.cpp-infill')) return;
  if (infillEndpoint(config.baseUrl)) return { config, model };
}

export class SovranInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider, vscode.Disposable
{
  private readonly requests = new InfillRequests();
  private readonly subscriptions: vscode.Disposable[];
  private registration: vscode.Disposable | undefined;
  private manual:
    | {
        uri: string;
        version: number;
        position: vscode.Position;
        item: vscode.InlineCompletionItem;
      }
    | undefined;

  constructor(
    private readonly workspace: VscodeWorkspace,
    private readonly secrets: ProviderSecrets,
    private readonly logger: Pick<HostLogger, 'debug'>,
  ) {
    const cancel = () => {
      this.manual = undefined;
      this.requests.cancel();
    };
    const invalidate = () => this.requests.invalidate();
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(invalidate),
      vscode.window.onDidChangeTextEditorSelection(invalidate),
      vscode.workspace.onDidChangeWorkspaceFolders(cancel),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.registerIfEnabled()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.length) invalidate();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sovran.autocomplete') || e.affectsConfiguration('sovran.providers')) {
          cancel();
          this.registration?.dispose();
          this.registration = undefined;
          this.registerIfEnabled();
        } else if (
          e.affectsConfiguration('sovran.security.protectedPaths') ||
          e.affectsConfiguration('files.exclude')
        ) {
          cancel();
        }
      }),
    ];
    this.registerIfEnabled();
  }

  private registerIfEnabled(): void {
    if (this.registration || !vscode.workspace.isTrusted || !readAutocompleteEnabled() || !selectedProvider())
      return;
    this.registration = vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, this);
  }

  async trigger(): Promise<void> {
    if (!readAutocompleteEnabled() || !selectedProvider()) {
      void vscode.window.showInformationMessage(
        'Enable inline autocomplete and choose an Autocomplete model in Sovran Settings.',
      );
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!vscode.workspace.isTrusted || !editor) return;
    this.registerIfEnabled();
    const { document } = editor;
    const version = document.version;
    const position = editor.selection.active;
    const source = new vscode.CancellationTokenSource();
    try {
      this.logger.debug('Inline completion requested manually.');
      const items = await this.provideInlineCompletionItems(
        document,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
          selectedCompletionInfo: undefined,
        },
        source.token,
      );
      if (!items?.[0]) return;
      // The native command can ask several times while setting up its suggestion UI. Reuse this
      // single explicit request while VS Code chooses and renders the item.
      const manual = { uri: document.uri.toString(), version, position, item: items[0] };
      this.manual = manual;
      try {
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      } finally {
        if (this.manual === manual) this.manual = undefined;
      }
    } finally {
      source.dispose();
    }
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (
      !readAutocompleteEnabled() ||
      !vscode.workspace.isTrusted ||
      document.uri.scheme !== 'file' ||
      token.isCancellationRequested ||
      context.selectedCompletionInfo
    )
      return;
    const version = document.version;
    const uri = document.uri.toString();
    const modelRef = readAutocompleteModel();
    const current = () => {
      const editor = vscode.window.activeTextEditor;
      return (
        !token.isCancellationRequested &&
        vscode.workspace.isTrusted &&
        readAutocompleteEnabled() &&
        readAutocompleteModel() === modelRef &&
        editor?.document.uri.toString() === uri &&
        editor.document.version === version &&
        document.version === version &&
        editor.selections.length === 1 &&
        editor.selection.isEmpty &&
        editor.selection.active.isEqual(position)
      );
    };
    if (!current()) return;
    const cached = this.manual;
    if (cached?.uri === uri && cached.version === version && cached.position.isEqual(position))
      return [cached.item];
    const selected = selectedProvider();
    if (!selected) return;
    const cancellation = new AbortController();
    const listener = token.onCancellationRequested(() => cancellation.abort());
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    try {
      const completion = await this.requests.complete(
        manual,
        cancellation.signal,
        current,
        async (signal) => {
          const file = await automaticFile(
            document.uri.fsPath,
            this.workspace,
            readSettings().agent.policy.protectedPaths,
            excludesWorkspaceFile,
          );
          if (!file || signal.aborted || !current()) {
            if (manual && !file) this.logger.debug('Inline completion skipped for an ineligible document.');
            return;
          }
          const offset = document.offsetAt(position);
          const prefix = document.getText(
            new vscode.Range(document.positionAt(Math.max(0, offset - INFILL_LIMITS.prefix)), position),
          );
          const suffix = document.getText(
            new vscode.Range(position, document.positionAt(offset + INFILL_LIMITS.suffix)),
          );
          if (!prefix.trim() && !suffix.trim()) return;
          return requestInfill(
            {
              config: selected.config,
              getApiKey: async () =>
                normalizeApiKey((await this.secrets.get(selected.config.id)) ?? '').key || undefined,
            },
            { model: selected.model, prefix, suffix },
            signal,
            current,
          );
        },
      );
      if (completion && current())
        return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
      if (manual) this.logger.debug('Inline completion returned no current suggestion.');
    } finally {
      listener.dispose();
    }
  }

  dispose(): void {
    this.requests.cancel();
    this.registration?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
