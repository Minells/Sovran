import { gitBranchesTool, gitDiffTool, gitLogTool, gitShowTool, gitStatusTool } from './gitTools';
import { gitStageTool, gitUnstageTool, gitCommitTool, gitFetchTool, gitPushTool, gitPullTool, gitRebaseTool } from './gitWriteTools';
import { CORE_UNIT } from '../loading';
import { ToolRegistry } from '../registry';
import type { AnyTool } from '../types';
import { diagnosticsTool } from './diagnosticsTool';
import { documentSymbolsTool, definitionTool, referencesTool } from './semanticTools';
import { webFetchTool } from './webFetchTool';
import { activeEditorTool, findFilesTool, listDirectoryTool, readFileTool, searchFilesTool, workspaceInfoTool } from './readTools';
import { executeTerminalTool } from './terminalTool';
import { applyDiffTool, editFileTool, writeFileTool } from './writeTools';

/** Native tools by settings group, then by the unit they load with (see `tools/loading.ts`). */
const NATIVE_TOOLS: Record<string, Record<string, AnyTool[]>> = {
  files: { [CORE_UNIT]: [readFileTool, listDirectoryTool, findFilesTool, searchFilesTool] },
  context: {
    [CORE_UNIT]: [workspaceInfoTool, activeEditorTool],
    diagnostics: [diagnosticsTool],
    symbols: [documentSymbolsTool, definitionTool, referencesTool],
  },
  web: { web: [webFetchTool] },
  editing: { [CORE_UNIT]: [writeFileTool, editFileTool, applyDiffTool] },
  terminal: { [CORE_UNIT]: [executeTerminalTool] },
  git: {
    git: [gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBranchesTool],
    'git.changes': [gitStageTool, gitUnstageTool, gitCommitTool],
    'git.remote': [gitFetchTool, gitPushTool, gitPullTool, gitRebaseTool],
  },
};

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [group, units] of Object.entries(NATIVE_TOOLS)) {
    for (const [unit, tools] of Object.entries(units)) {
      for (const tool of tools) registry.register({ ...tool, source: { kind: 'native' }, group, unit });
    }
  }
  return registry;
}
