/**
 * Minimal, tolerant Server-Sent Events parser.
 * Yields the `data` payload of each event (multi-line data joined with "\n").
 * Handles CRLF/CR/LF line endings, comments, other fields, and a missing trailing blank line.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];

  const takeLines = function* (final: boolean): Generator<string> {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      // A trailing lone "\r" might be the first half of "\r\n": wait for more input.
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield line;
    }
    if (final && buffer.length > 0) {
      const line = buffer;
      buffer = '';
      yield line;
    }
  };

  function* handle(line: string): Generator<string> {
    if (line === '') {
      if (data.length > 0) {
        yield data.join('\n');
        data = [];
      }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines(false)) yield* handle(line);
    }
    buffer += decoder.decode();
    for (const line of takeLines(true)) yield* handle(line);
    yield* handle('');
  } finally {
    reader.releaseLock();
  }
}
