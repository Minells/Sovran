import * as vscode from 'vscode';
import type { SemanticLocation, SemanticQuery } from '../../core/ports';
import { ToolError } from '../../core/tools/types';

const QUERY_TIMEOUT_MS = 10_000;

function* documentSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  uri: vscode.Uri,
): Iterable<SemanticLocation> {
  for (const symbol of symbols) {
    // The command can return symbols with both a location and a more precise selection range.
    const hierarchical = 'selectionRange' in symbol;
    const target = hierarchical ? uri : symbol.location.uri;
    if (target.scheme !== 'file') continue;
    const position = hierarchical ? symbol.selectionRange.start : symbol.location.range.start;
    yield { path: target.fsPath, line: position.line + 1, column: position.character + 1, name: symbol.name };
    if (hierarchical) yield* documentSymbols(symbol.children ?? [], uri);
  }
}

function* positions(
  locations: readonly (vscode.Location | vscode.LocationLink)[],
): Iterable<SemanticLocation> {
  for (const location of locations) {
    const link = 'targetUri' in location;
    const target = link ? location.targetUri : location.uri;
    if (target.scheme !== 'file') continue;
    const position = link
      ? (location.targetSelectionRange ?? location.targetRange).start
      : location.range.start;
    yield { path: target.fsPath, line: position.line + 1, column: position.character + 1 };
  }
}

function requireTrust(): void {
  if (!vscode.workspace.isTrusted) throw new ToolError('Trust the workspace to use semantic navigation.');
}

async function execute(query: SemanticQuery, signal: AbortSignal): Promise<Iterable<SemanticLocation>> {
  requireTrust();
  const uri = vscode.Uri.file(query.path);
  const document = await vscode.workspace.openTextDocument(uri);
  signal.throwIfAborted();
  requireTrust();
  if (query.kind === 'symbols') {
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >('vscode.executeDocumentSymbolProvider', uri);
    return documentSymbols(symbols ?? [], uri);
  }
  if (query.line > document.lineCount || query.column > document.lineAt(query.line - 1).text.length + 1)
    throw new ToolError(
      'The position is outside the current file. Check the one-based line and UTF-16 column.',
    );
  const position = new vscode.Position(query.line - 1, query.column - 1);
  const command =
    query.kind === 'definition' ? 'vscode.executeDefinitionProvider' : 'vscode.executeReferenceProvider';
  const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    command,
    uri,
    position,
  );
  return positions(locations ?? []);
}

/** VS Code commands do not accept cancellation tokens. Stop waiting and discard late results. */
export async function querySemantic(
  query: SemanticQuery,
  signal: AbortSignal,
): Promise<Iterable<SemanticLocation>> {
  if (signal.aborted) throw new ToolError('Cancelled by the user.');
  const stop = AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]);
  let interrupt: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () =>
      reject(
        new ToolError(
          signal.aborted
            ? 'Cancelled by the user.'
            : 'VS Code did not answer within 10 seconds. Try search_files or retry after indexing.',
        ),
      );
    stop.addEventListener('abort', interrupt, { once: true });
  });
  try {
    return await Promise.race([interrupted, execute(query, stop)]);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      'VS Code could not query the language provider. Check the language support or use search_files.',
    );
  } finally {
    stop.removeEventListener('abort', interrupt!);
  }
}
