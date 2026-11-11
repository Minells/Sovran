// Bundled only into the smoke runner's temporary directory, never exported by the product extension.
import { CheckpointRecorder } from '../../src/core/checkpoints/checkpoints';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { VscodeWorkspace } from '../../src/extension/adapters/VscodeWorkspace';

export async function readDiagnostics(args: unknown) {
  const tool = createBuiltinRegistry().get('get_diagnostics')!;
  const workspace = new CheckpointRecorder(new VscodeWorkspace());
  const unexpectedProcess = async (): Promise<never> => {
    throw new Error('Diagnostics must not spawn a process.');
  };
  return tool.execute(
    tool.schema.parse(args),
    {
      workspace,
      process: { run: unexpectedProcess, runFile: unexpectedProcess },
      signal: new AbortController().signal,
      settings: { protectedPaths: ['**/.env'], maxToolResultChars: 2000, terminalTimeoutMs: 1000 },
    },
    { paths: [] },
  );
}
