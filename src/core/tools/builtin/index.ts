import { gitBranchesTool, gitDiffTool, gitLogTool, gitShowTool, gitStatusTool } from './gitTools';
import { gitStageTool, gitUnstageTool, gitCommitTool } from './gitWriteTools';
import { ToolRegistry } from '../registry';
import { diagnosticsTool } from './diagnosticsTool';
import { webFetchTool } from './webFetchTool';
import { activeEditorTool, findFilesTool, listDirectoryTool, readFileTool, searchFilesTool, workspaceInfoTool } from './readTools';
import { executeTerminalTool } from './terminalTool';
import { applyDiffTool, editFileTool, writeFileTool } from './writeTools';

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const groups = {
    files: [readFileTool, listDirectoryTool, findFilesTool, searchFilesTool],
    context: [workspaceInfoTool, activeEditorTool, diagnosticsTool],
    web: [webFetchTool],
    editing: [writeFileTool, editFileTool, applyDiffTool],
    terminal: [executeTerminalTool],
    git: [gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBranchesTool, gitStageTool, gitUnstageTool, gitCommitTool],
  };
  for (const [group, tools] of Object.entries(groups)) {
    for (const tool of tools) registry.register({ ...tool, source: { kind: 'native' }, group });
  }
  return registry;
}
