/**
 * A small XML tokenizer for the parts of Office and OpenDocument files. It is deliberately not a full parser:
 *
 * - Document type declarations are skipped, and only the five predefined entities and character references are
 *   decoded, so a file cannot define entities (no "billion laughs" expansion) or reference external ones (no XXE).
 * - It never throws on malformed input: an unterminated construct ends the stream.
 * - It is lazy, so a converter that has read enough stops without tokenizing the rest of a large part.
 */

export type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '�';
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === '#')
      return codePoint(
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10),
      );
    return NAMED[ref] ?? whole;
  });
}

const ATTR = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(s: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!s) return attrs;
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(s); m; m = ATTR.exec(s)) attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/** Index just past the `>` that closes a declaration starting at `from`, skipping an internal subset in `[...]`. */
function skipDeclaration(xml: string, from: number): number {
  let depth = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i + 1;
  }
  return xml.length;
}

export function* parseXml(xml: string): Generator<XmlEvent> {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      yield { type: 'text', text: decodeEntities(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { type: 'text', text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) return;
      yield { type: 'text', text: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      i = skipDeclaration(xml, lt + 2);
      continue;
    }
    // A tag: its `>` is the first one outside a quoted attribute value.
    let j = lt + 1;
    let quote = 0;
    for (; j < n; j++) {
      const c = xml.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x3e) break;
    }
    if (j >= n) return;
    const inner = xml.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      yield { type: 'close', name: inner.slice(1).trim() };
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/\s/);
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
    if (!name) continue;
    yield {
      type: 'open',
      name,
      attrs: parseAttributes(nameEnd === -1 ? '' : body.slice(nameEnd)),
      selfClosing,
    };
  }
}

/** The name without its namespace prefix: `w:p` → `p`. */
export const localName = (name: string) => name.slice(name.indexOf(':') + 1);

/**
 * Decodes an XML part. Parts are UTF-8 unless they start with a UTF-16 byte-order mark, which the Office formats
 * allow.
 */
export function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}
