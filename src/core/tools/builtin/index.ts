import { gitBranchesTool, gitDiffTool, gitLogTool, gitShowTool, gitStatusTool } from './gitTools';
import { ToolRegistry } from '../registry';
import { activeEditorTool, findFilesTool, listDirectoryTool, readFileTool, searchFilesTool, workspaceInfoTool } from './readTools';
import { executeTerminalTool } from './terminalTool';
import { applyDiffTool, editFileTool, writeFileTool } from './writeTools';

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const groups = {
    files: [readFileTool, listDirectoryTool, findFilesTool, searchFilesTool],
    context: [workspaceInfoTool, activeEditorTool],
    editing: [writeFileTool, editFileTool, applyDiffTool],
    terminal: [executeTerminalTool],
    git: [gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBranchesTool],
  };
  for (const [group, tools] of Object.entries(groups)) {
    for (const tool of tools) registry.register({ ...tool, source: { kind: 'native' }, group });
  }
  return registry;
}
