import { ToolRegistry } from '../registry';
import { activeEditorTool, findFilesTool, listDirectoryTool, readFileTool, searchFilesTool, workspaceInfoTool } from './readTools';
import { executeTerminalTool } from './terminalTool';
import { applyDiffTool, editFileTool, writeFileTool } from './writeTools';

export function createBuiltinRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(listDirectoryTool)
    .register(findFilesTool)
    .register(searchFilesTool)
    .register(workspaceInfoTool)
    .register(activeEditorTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(applyDiffTool)
    .register(executeTerminalTool);
}
