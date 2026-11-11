import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileProcessEnvironment,
  OutputBuffer,
  runFileProcess,
  runProcess,
} from '../../src/extension/adapters/processExecution';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true });
});
const options = (cwd = os.tmpdir()) => ({
  cwd,
  timeoutMs: 3000,
  signal: new AbortController().signal,
  maxOutputChars: 2000,
});

describe('structured process execution', () => {
  it('passes shell metacharacters and spaces as literal argv and separates stdout from stderr', async () => {
    const args = ['space here', '; echo injected', '$(touch forbidden)', '`id`', '--flag', 'ä😀'];
    const result = await runFileProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write("diagnostic")',
        ...args,
      ],
      options(),
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toBe('diagnostic');
  });

  it('decodes UTF-8 split across stream chunks without corrupting structured fields', async () => {
    const result = await runFileProcess(
      process.execPath,
      [
        '-e',
        'const b=Buffer.from("😀");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)',
      ],
      options(),
    );
    expect(result.stdout).toBe('😀');
  });

  it('does not start a process when already cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await runFileProcess(process.execPath, ['-e', 'process.stdout.write("started")'], {
      ...options(),
      signal: abort.signal,
    });
    expect(result).toMatchObject({ cancelled: true, stdout: '' });
  });

  it('terminates a timed-out process and cancels a running one', async () => {
    const timeout = await runFileProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ...options(),
      timeoutMs: 50,
    });
    expect(timeout.timedOut).toBe(true);
    const abort = new AbortController();
    const running = runFileProcess(
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      { ...options(), signal: abort.signal, onOutput: () => abort.abort() },
    );
    expect((await running).cancelled).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'cancels descendants even after the original process has exited',
    async () => {
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-tree-'));
      folders.push(folder);
      const marker = path.join(folder, 'descendant-finished');
      const fixture = fileURLToPath(new URL('../fixtures/descendantProcess.cjs', import.meta.url));
      const abort = new AbortController();
      const result = await runFileProcess(process.execPath, [fixture, 'parent'], {
        ...options(folder),
        signal: abort.signal,
        onOutput: (chunk) => {
          if (chunk.includes('ready')) abort.abort();
        },
      });
      expect(result.cancelled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
    },
  );

  it('bounds output and preserves ordinary shell execution through the shared lifecycle', async () => {
    const result = await runFileProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
      ...options(),
      maxOutputChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(150);
    const shell = await runProcess('echo sovran', [], options(), {
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      env: process.env,
    });
    expect(shell.output.trim()).toBe('sovran');
    expect(shell.exitCode).toBe(0);
  });

  it('rejects a repository executable and relative PATH entries, including symlinks', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-process-'));
    folders.push(folder);
    const actual = await fs.realpath(folder);
    const bin = path.join(actual, process.platform === 'win32' ? 'fake.exe' : 'fake');
    await fs.writeFile(bin, '#!/bin/sh\necho forbidden\n', { mode: 0o755 });
    const result = await runFileProcess(path.basename(bin), [], {
      ...options(actual),
      env: { PATH: `.${path.delimiter}${actual}` },
    });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('outside the workspace');
    const missing = await runFileProcess('missing-sovran-executable', [], {
      ...options(actual),
      env: { PATH: '' },
    });
    expect(missing.exitCode).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a PATH symlink whose executable target is inside the workspace',
    async () => {
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-path-link-'));
      folders.push(folder);
      const repository = path.join(folder, 'repository');
      const hostBin = path.join(folder, 'bin');
      await fs.mkdir(repository);
      await fs.mkdir(hostBin);
      const executable = path.join(repository, 'git');
      await fs.writeFile(executable, '#!/bin/sh\necho forbidden\n', { mode: 0o755 });
      await fs.symlink(executable, path.join(hostBin, 'git'));
      const result = await runFileProcess('git', [], { ...options(repository), env: { PATH: hostBin } });
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('outside the workspace');
    },
  );

  it('does not inherit Git redirection, credentials or runtime preload variables', () => {
    const env = fileProcessEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/user',
        GIT_DIR: '/outside',
        GIT_CONFIG_COUNT: '1',
        NODE_OPTIONS: '--require evil',
        TOKEN: 'secret',
        ELECTRON_RUN_AS_NODE: '1',
      },
      { GIT_NO_LAZY_FETCH: '1' },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/user', GIT_NO_LAZY_FETCH: '1' });
  });

  it('forwards only explicitly requested signing locations alongside the minimal environment', () => {
    const env = fileProcessEnvironment(
      {
        PATH: '/bin',
        SSH_AUTH_SOCK: '/agent.sock',
        GNUPGHOME: '/keys',
        GIT_DIR: '/redirect',
        NODE_OPTIONS: '--require evil',
        TOKEN: 'secret',
      },
      {},
      ['SSH_AUTH_SOCK', 'GNUPGHOME'],
    );
    expect(env).toEqual({ PATH: '/bin', SSH_AUTH_SOCK: '/agent.sock', GNUPGHOME: '/keys' });
  });

  it('marks output truncated only after the full budget is exceeded', () => {
    const buffer = new OutputBuffer(10);
    buffer.push('12345678');
    expect(buffer.truncated).toBe(false);
    buffer.push('90123');
    expect(buffer.truncated).toBe(true);
    expect(buffer.toString()).toContain('123456\n');
    expect(buffer.toString()).toMatch(/0123$/);
  });
});
