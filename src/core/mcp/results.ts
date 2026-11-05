/**
 * Turns an MCP tool result into the text the model reads. Text passes through; images, audio and binary resources
 * become a short label (the model gets tool results as text); structured content is shown as JSON when the server sent
 * no text. The agent runner then redacts secrets and shortens the result like any other tool output.
 */

/** Stops reading once this much text is collected: the runner keeps far less, and a server may send megabytes. */
const MAX_COLLECTED = 400_000;

export interface FormattedResult {
  text: string;
  isError: boolean;
}

const size = (base64: unknown) => {
  if (typeof base64 !== 'string') return '';
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes >= 1024 * 1024
    ? `, ${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `, ${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function block(b: unknown): string {
  if (!b || typeof b !== 'object') return '';
  const c = b as Record<string, unknown>;
  switch (c.type) {
    case 'text':
      return str(c.text) ?? '';
    case 'image':
    case 'audio':
      return `[${c.type === 'image' ? 'Image' : 'Audio'} (${str(c.mimeType) ?? 'unknown type'}${size(c.data)}) returned by the tool; it is not shown to the model.]`;
    case 'resource': {
      const r = (c.resource ?? {}) as Record<string, unknown>;
      const uri = str(r.uri) ?? 'unknown';
      const text = str(r.text);
      return text !== undefined
        ? `Resource ${uri}:\n${text}`
        : `[Binary resource ${uri} (${str(r.mimeType) ?? 'unknown type'}${size(r.blob)}); it is not shown to the model.]`;
    }
    case 'resource_link': {
      const name = str(c.name) ?? str(c.title);
      return `Link to resource ${name ? `"${name}" ` : ''}<${str(c.uri) ?? 'unknown'}>${str(c.description) ? `: ${str(c.description)}` : ''}`;
    }
    default:
      return `[Content of type "${String(c.type)}" that Sovran cannot show.]`;
  }
}

export function formatToolResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}): FormattedResult {
  const parts: string[] = [];
  let collected = 0;
  for (const b of Array.isArray(result.content) ? result.content : []) {
    if (collected >= MAX_COLLECTED) {
      parts.push('[More content was returned and left out.]');
      break;
    }
    const text = block(b);
    if (!text) continue;
    parts.push(text);
    collected += text.length;
  }
  const hasText = parts.some((p) => !p.startsWith('['));
  if (!hasText && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2).slice(0, MAX_COLLECTED));
    } catch {
      parts.push('[Structured content that could not be shown.]');
    }
  }
  const isError = result.isError === true;
  return {
    text:
      parts.join('\n\n') ||
      (isError ? 'The tool failed without saying why.' : 'The tool returned no content.'),
    isError,
  };
}
