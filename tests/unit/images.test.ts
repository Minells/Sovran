/**
 * Images for vision models in the core (recognition, the request content, refusals and what the agent learns), and
 * read_file on documents through the shared document reader.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import { CheckpointRecorder } from '../../src/core/checkpoints/checkpoints';
import { renderForSummary } from '../../src/core/context/compaction';
import { buildContext, imageLabel, wireTokens } from '../../src/core/context/contextManager';
import { convertDocument } from '../../src/core/documents/convert';
import { sniffFile } from '../../src/core/documents/detect';
import { DocumentReader } from '../../src/core/documents/reader';
import { DocumentError } from '../../src/core/documents/types';
import { estimateImageTokens, imageInfo } from '../../src/core/images/images';
import { imageId } from '../../src/core/images/imageId';
import { nullLogger, type DocumentConverterPort } from '../../src/core/ports';
import { MemoryCapabilityStore, capabilityKey, resolveVision } from '../../src/core/providers/capabilities';
import { ProviderError, errorFromResponse } from '../../src/core/providers/errors';
import { carriesImages, type ModelConfig } from '../../src/core/providers/types';
import type { ImageAttachment, Session, SessionMessage, UserMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { readFileTool } from '../../src/core/tools/builtin/readTools';
import type { ToolContext } from '../../src/core/tools/types';
import { makePdf, PDFJS_WARMUP_MS, warmUpPdfJs } from '../fixtures/documents';
import { FakeProcess, MemoryWorkspace, ScriptedApprovals, ScriptedProvider, text } from '../fixtures/fakes';
import { makeGif, makeJpeg, makePng, makeWebp } from '../fixtures/images';

const shot: ImageAttachment = {
  id: 'a'.repeat(64),
  name: 'shot.png',
  source: 'pasted',
  mime: 'image/png',
  bytes: 100,
  width: 1280,
  height: 720,
};
const user = (content: string, extra: Partial<UserMessage> = {}): UserMessage => ({
  role: 'user',
  id: `u-${content}`,
  content,
  createdAt: 0,
  ...extra,
});
const context = (messages: SessionMessage[], extra: Partial<Parameters<typeof buildContext>[0]> = {}) =>
  buildContext({
    systemPrompt: 'sys',
    messages,
    toolMode: 'native',
    budgetTokens: 100_000,
    toolSchemaTokens: 0,
    maxToolResultChars: 20_000,
    ...extra,
  });

describe('imageInfo', () => {
  it('reads the format and size of the images models accept', () => {
    expect(imageInfo(makePng(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    // EXIF and other metadata come before a JPEG's frame header.
    expect(imageInfo(makeJpeg(1920, 1080, 30_000))).toEqual({
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
    });
    expect(imageInfo(makeGif(32, 16))).toEqual({ mime: 'image/gif', width: 32, height: 16 });
    expect(imageInfo(makeWebp(300, 200, 'VP8 '))).toEqual({ mime: 'image/webp', width: 300, height: 200 });
    expect(imageInfo(makeWebp(4000, 3000, 'VP8L'))).toEqual({
      mime: 'image/webp',
      width: 4000,
      height: 3000,
    });
    expect(imageInfo(makeWebp(5000, 70, 'VP8X'))).toEqual({ mime: 'image/webp', width: 5000, height: 70 });
  });

  it('knows the format even when the size is cut off, and ignores everything else', () => {
    expect(imageInfo(makeJpeg(10, 10, 30_000).subarray(0, 8000))).toEqual({ mime: 'image/jpeg' });
    expect(imageInfo(Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0]))).toBeUndefined(); // BMP
    expect(imageInfo(new TextEncoder().encode('GIF89a is a format'))).toMatchObject({ mime: 'image/gif' });
  });

  it('is recognized by the sniffer only in a binary file, so text never changes kind', () => {
    expect(sniffFile(makePng(2, 2))).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniffFile(makeJpeg(2, 2))).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(sniffFile(new TextEncoder().encode('GIF89a is a format from 1989'))).toEqual({
      kind: 'text',
      encoding: 'utf-8',
    });
    expect(sniffFile(Uint8Array.from([0x42, 0x4d, 0x36, 0, 0, 0, 0, 0]))).toEqual({
      kind: 'unsupported',
      family: 'image',
    });
  });

  it('estimates tokens like a vision model that scales large images down', () => {
    expect(estimateImageTokens({ width: 100, height: 100 })).toBe(85);
    expect(estimateImageTokens({ width: 1280, height: 720 })).toBe(1229);
    expect(estimateImageTokens({ width: 8000, height: 8000 })).toBe(1600);
    expect(estimateImageTokens({})).toBe(1600);
    expect(imageId(makePng(2, 2))).toMatch(/^[a-f0-9]{64}$/);
    expect(imageId(makePng(2, 2))).not.toBe(imageId(makePng(2, 2, 7)));
  });
});

describe('request content with images', () => {
  it('keeps a message without images a plain string', () => {
    expect(context([user('hello')]).messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('sends each image after its label, then the text, and counts the image in the budget', () => {
    const url = 'data:image/png;base64,AAAA';
    const ctx = context([user('what is wrong here?', { images: [shot] })], {
      images: new Map([[shot.id, url]]),
      vision: true,
    });
    expect(ctx.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '<image name="shot.png" type="PNG image" size="1280×720"/>' },
        { type: 'image_url', image_url: { url } },
        { type: 'text', text: 'what is wrong here?' },
      ],
    });
    expect(carriesImages(ctx.messages)).toBe(true);
    expect(wireTokens(ctx.messages[1]!)).toBeGreaterThan(1229);
  });

  it('sends only the label when the model takes no images, or the image is gone', () => {
    const noVision = context([user('see?', { images: [shot] })], {
      images: new Map([[shot.id, 'data:x']]),
      vision: false,
    });
    expect(noVision.messages[1]).toEqual({
      role: 'user',
      content: `${imageLabel(shot, 'unsupported')}\n\nsee?`,
    });
    expect(imageLabel(shot, 'unsupported')).toContain('note="Not sent: this model does not accept images.');
    const gone = context([user('see?', { images: [shot] })], { images: new Map(), vision: true });
    expect(gone.messages[1]!.content).toContain('note="Not sent: the image is no longer available."');
    expect(carriesImages(gone.messages)).toBe(false);
  });

  it('escapes the name, and lists images for the summary of compacted turns', () => {
    expect(imageLabel({ ...shot, name: 'a" onload="x.png', width: undefined, height: undefined })).toBe(
      '<image name="a&quot; onload=&quot;x.png" type="PNG image"/>',
    );
    expect(renderForSummary([user('look', { images: [shot] })], undefined, 10_000)).toContain(
      '(attached: shot.png (image))',
    );
  });

  it('keeps prompted tool results valid after a message with images', () => {
    const messages: SessionMessage[] = [
      user('read it', { images: [shot] }),
      {
        role: 'assistant',
        id: 'a1',
        content: '',
        toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        createdAt: 0,
      },
      {
        role: 'tool',
        id: 'r1',
        toolCallId: 't1',
        toolName: 'read_file',
        content: 'x',
        status: 'success',
        durationMs: 1,
        createdAt: 0,
      },
    ];
    const ctx = context(messages, {
      toolMode: 'prompted',
      images: new Map([[shot.id, 'data:y']]),
      vision: true,
    });
    expect(ctx.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(ctx.messages[3]!.content).toContain('<tool_result');
  });
});

describe('image refusals', () => {
  const refused = (status: number, body: string, imagesSent = true) =>
    errorFromResponse(status, JSON.stringify({ error: { message: body } }), { url: 'u', imagesSent }).kind;

  it('reads the common refusals as "this model does not accept images"', () => {
    expect(refused(400, 'qwen2.5-coder is not a multimodal model')).toBe('vision_unsupported');
    expect(refused(500, 'image input is not supported by this server')).toBe('vision_unsupported');
    expect(refused(422, 'messages.1.content: Input should be a valid string')).toBe('vision_unsupported');
  });

  it('does not read a limit, a context overflow or a request without images as a refusal', () => {
    expect(refused(400, 'At most 1 image(s) may be provided in one request')).toBe('bad_request');
    expect(refused(400, 'Image size exceeds the maximum of 20 MB')).toBe('bad_request');
    expect(refused(400, "This model's maximum context length is 4096 tokens")).toBe('context_length');
    expect(refused(400, 'not a multimodal model', false)).toBe('bad_request');
  });
});

describe('the agent with images', () => {
  const settings: AgentSettings = {
    maxIterations: 5,
    policy: { approvalMode: 'ask', allowedCommands: [], protectedPaths: [] },
    tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: [] },
    defaultContextWindow: 32_768,
    defaultMaxOutputTokens: 1024,
  } as AgentSettings;
  const session = (): Session => ({
    id: 's',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    mode: 'act',
    messages: [user('what is this?', { images: [shot] })],
  });

  async function run(
    provider: ScriptedProvider,
    model: ModelConfig,
    capabilities = new MemoryCapabilityStore(),
  ) {
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      registry: createBuiltinRegistry(),
      workspace: new MemoryWorkspace(),
      process: new FakeProcess(),
      approvals: new ScriptedApprovals(() => ({ approved: false })),
      capabilities,
      logger: nullLogger,
    });
    const outcome = await runner.run({
      session: session(),
      providerId: 'p',
      model,
      mode: 'act',
      settings,
      grants: { edits: false },
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      images: new Map([[shot.id, 'data:image/png;base64,AAAA']]),
    });
    return { outcome, events, notices: events.flatMap((e) => (e.type === 'notice' ? [e.message] : [])) };
  }
  const userContent = (p: ScriptedProvider, i: number) =>
    p.requests[i]!.messages.find((m) => m.role === 'user')!.content;

  it('sends images, and on a refusal remembers the model as text-only and retries with their names', async () => {
    const capabilities = new MemoryCapabilityStore();
    const provider = new ScriptedProvider([
      new ProviderError('vision_unsupported', 'HTTP 400: not a multimodal model'),
      [text('I only see its name')],
    ]);
    const { outcome, notices } = await run(provider, { id: 'coder' }, capabilities);
    expect(outcome.reason).toBe('completed');
    expect(Array.isArray(userContent(provider, 0))).toBe(true);
    expect(userContent(provider, 1)).toBe(`${imageLabel(shot, 'unsupported')}\n\nwhat is this?`);
    expect(capabilities.get(capabilityKey('p', 'coder'))).toMatchObject({ vision: false });
    expect(notices).toEqual([
      expect.stringMatching(/coder does not accept images\. Sovran sent their names instead and retried/),
    ]);

    // The next run knows it: names only, and the user is told before the answer.
    const next = new ScriptedProvider([[text('ok')]]);
    const again = await run(next, { id: 'coder' }, capabilities);
    expect(typeof userContent(next, 0)).toBe('string');
    expect(again.notices).toEqual([
      expect.stringMatching(/coder does not accept images, so it receives only their names/),
    ]);
  });

  it('reports the refusal for a model configured to see images, and never sends them when configured not to', async () => {
    const strict = new ScriptedProvider([
      new ProviderError('vision_unsupported', 'HTTP 400: no images', 'hint'),
    ]);
    expect((await run(strict, { id: 'vl', vision: true })).outcome).toMatchObject({
      reason: 'error',
      error: { kind: 'vision_unsupported' },
    });
    const textOnly = new ScriptedProvider([[text('ok')]]);
    await run(textOnly, { id: 'small', vision: false });
    expect(typeof userContent(textOnly, 0)).toBe('string');
    expect(resolveVision(undefined, undefined)).toBe(true);
    expect(resolveVision(undefined, { vision: false, updatedAt: 0 })).toBe(false);
    expect(resolveVision(true, { vision: false, updatedAt: 0 })).toBe(true);
  });
});

describe('DocumentReader', () => {
  const counting = () => {
    const calls: number[] = [];
    const converter: DocumentConverterPort = {
      convert: async (data, o) => {
        calls.push(o.maxChars);
        if (data[0] === 0) throw new DocumentError('corrupt', 'bad');
        return { format: 'pdf', markdown: `v${calls.length}`, truncated: false };
      },
    };
    return { calls, reader: new DocumentReader(converter, 2) };
  };
  const pdf = async () => new Uint8Array([1]);

  it('converts a file once while its size and modification time stay the same', async () => {
    const { calls, reader } = counting();
    const [a, b] = await Promise.all([
      reader.read('/a.pdf', { size: 1, mtimeMs: 1 }, pdf, 100),
      reader.read('/a.pdf', { size: 1, mtimeMs: 1 }, pdf, 100),
    ]);
    expect([a.markdown, b.markdown, calls]).toEqual(['v1', 'v1', [100]]);
    expect((await reader.read('/a.pdf', { size: 1, mtimeMs: 2 }, pdf, 100)).markdown).toBe('v2');
    // Another budget is another conversion; the oldest entry is evicted beyond the capacity.
    await reader.read('/a.pdf', { size: 1, mtimeMs: 2 }, pdf, 999);
    await reader.read('/b.pdf', { size: 1, mtimeMs: 2 }, pdf, 100);
    await reader.read('/a.pdf', { size: 1, mtimeMs: 2 }, pdf, 100);
    expect(calls).toEqual([100, 100, 999, 100, 100]);
  });

  it('does not keep a failed conversion', async () => {
    const { calls, reader } = counting();
    await expect(
      reader.read('/x.pdf', { size: 1, mtimeMs: 1 }, async () => new Uint8Array([0]), 100),
    ).rejects.toMatchObject({ code: 'corrupt' });
    await reader.read('/x.pdf', { size: 1, mtimeMs: 1 }, pdf, 100);
    expect(calls).toHaveLength(2);
  });
});

describe('read_file on documents', () => {
  beforeAll(warmUpPdfJs, PDFJS_WARMUP_MS);
  const inProcess: DocumentConverterPort = { convert: (data, o) => convertDocument(data, o) };
  // null: no document reader, as for a host that does not provide one.
  const ctxFor = (
    workspace: MemoryWorkspace,
    documents: DocumentReader | null = new DocumentReader(inProcess),
  ): ToolContext => ({
    workspace,
    process: new FakeProcess(),
    signal: new AbortController().signal,
    settings: { terminalTimeoutMs: 1000, maxToolResultChars: 20_000, protectedPaths: [] },
    ...(documents ? { documents } : {}),
  });
  const read = (ctx: ToolContext, args: { path: string; start_line?: number; end_line?: number }) =>
    readFileTool.execute(args, ctx, { paths: [] });

  it('returns a document as Markdown, says what it was, and pages through it by line', async () => {
    const ws = new MemoryWorkspace();
    ws.setBytes('docs/spec.pdf', makePdf([['Requisiti'], ['Allegato']]));
    const whole = await read(ctxFor(ws), { path: 'docs/spec.pdf' });
    expect(whole.content).toBe(
      'docs/spec.pdf (PDF document, 2 pages, converted to Markdown without images or layout; 7 lines)\n## Page 1\n\nRequisiti\n\n## Page 2\n\nAllegato',
    );
    expect(whole.summary).toBe('PDF document, 2 pages · 7 lines');
    const part = await read(ctxFor(ws), { path: 'docs/spec.pdf', start_line: 5, end_line: 7 });
    expect(part.content).toBe(
      'docs/spec.pdf (PDF document, 2 pages, converted to Markdown without images or layout; lines 5-7 of 7)\n## Page 2\n\nAllegato',
    );
  });

  it('works through the checkpoint recorder that wraps the workspace during a run', async () => {
    const ws = new MemoryWorkspace();
    ws.setBytes('a.pdf', makePdf([['Dentro una run']]));
    const ctx = { ...ctxFor(ws), workspace: new CheckpointRecorder(ws) };
    expect((await read(ctx, { path: 'a.pdf' })).content).toContain('Dentro una run');
  });

  it('decodes UTF-16 text and explains images instead of returning bytes', async () => {
    const ws = new MemoryWorkspace();
    ws.setBytes('out.txt', Uint8Array.from([0xff, 0xfe, ...Buffer.from('ciao\n', 'utf16le')]));
    ws.setBytes('ui.png', makePng(800, 600));
    expect((await read(ctxFor(ws), { path: 'out.txt' })).content).toBe('out.txt (2 lines)\nciao\n');
    await expect(read(ctxFor(ws), { path: 'ui.png' })).rejects.toThrow(
      'ui.png is a PNG image (800×600). read_file returns text only: if you need to see it, ask the user to attach it to a message.',
    );
  });

  it('keeps text and binary files as they were, also without a document reader', async () => {
    const ws = new MemoryWorkspace({ 'a.ts': 'export {}\n', 'pdf-notes.md': '%PDF- starts every PDF\n' });
    ws.setBytes('blob.bin', Uint8Array.from([0, 1, 2, 3]));
    ws.setBytes('doc.pdf', makePdf([['x']]));
    expect((await read(ctxFor(ws), { path: 'a.ts' })).content).toBe('a.ts (2 lines)\nexport {}\n');
    // Starts like a PDF but is not one: read as the text it is.
    expect((await read(ctxFor(ws), { path: 'pdf-notes.md' })).content).toBe(
      'pdf-notes.md (2 lines)\n%PDF- starts every PDF\n',
    );
    await expect(read(ctxFor(ws), { path: 'blob.bin' })).rejects.toThrow(
      'blob.bin appears to be a binary file.',
    );
    await expect(read(ctxFor(ws, null), { path: 'blob.bin' })).rejects.toThrow(
      'blob.bin appears to be a binary file.',
    );
    // Without a reader, a handwritten PDF (no NUL byte) still reads as text, as before.
    expect((await read(ctxFor(ws, null), { path: 'doc.pdf' })).content).toMatch(
      /^doc\.pdf \(\d+ lines\)\n%PDF-1\.4/,
    );
  });

  it('says why a document cannot be read', async () => {
    const ws = new MemoryWorkspace();
    ws.setBytes('scan.pdf', makePdf([[]]));
    await expect(read(ctxFor(ws), { path: 'scan.pdf' })).rejects.toThrow(
      /scan\.pdf has no text to read: it is probably a scanned image/,
    );
  });
});
