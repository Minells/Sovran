import { parseDocument } from 'htmlparser2';
import type { HtmlExtractorPort } from './types';
import { WEB_LIMITS } from './types';
import { webUrl } from './urls';

type Node = ReturnType<typeof parseDocument>['children'][number];
const SKIP = new Set([
  'script',
  'style',
  'nav',
  'footer',
  'header',
  'aside',
  'form',
  'iframe',
  'object',
  'embed',
  'noscript',
  'svg',
  'template',
  'head',
]);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'blockquote', 'ul', 'ol', 'dl', 'dt', 'dd']);
const escape = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&');
const fence = (value: string, minimum: number) => {
  let length = minimum;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
};

/** Pure bounded HTML parsing; no resource loading, scripts, CSS evaluation or browser DOM. Runs only in a worker. */
export function extractPage(
  html: string,
  url: string,
  maxChars: number,
): Awaited<ReturnType<HtmlExtractorPort['extract']>> {
  const doc = parseDocument(html);
  const nodes: Node[] = [...doc.children];
  let title = '';
  let main: Node | undefined;
  let article: Node | undefined;
  let body: Node | undefined;
  let scanned = 0;
  const plain = (node: Node, depth = 0): string => {
    if (depth > 64) return '';
    if (node.type === 'text') return node.data;
    return 'children' in node ? node.children.map((n) => plain(n, depth + 1)).join('') : '';
  };
  while (nodes.length && scanned++ < 50_000) {
    const node = nodes.pop()!;
    if ('name' in node) {
      if (node.name === 'title' && !title) title = plain(node).replace(/\s+/g, ' ').trim().slice(0, 256);
      if (node.name === 'main') main = node;
      if (node.name === 'article') article = node;
      if (node.name === 'body') body = node;
    }
    if ('children' in node) nodes.push(...node.children);
  }
  const links = new Set<string>();
  const codeBlocks: string[] = [];
  let rendered = 0;
  let limited = scanned >= 50_000;
  const render = (node: Node, depth = 0, inPre = false): string => {
    if (++rendered > 50_000 || depth > 64) {
      limited = true;
      return '';
    }
    if (node.type === 'text') return inPre ? node.data : escape(node.data.replace(/\s+/g, ' '));
    if (
      !('attribs' in node) ||
      SKIP.has(node.name) ||
      node.attribs.hidden !== undefined ||
      node.attribs['aria-hidden'] === 'true'
    )
      return '';
    const tag = node.name;
    const children = () => node.children.map((n) => render(n, depth + 1, inPre || tag === 'pre')).join('');
    if (tag === 'pre') {
      const value = children().replace(/^\n|\n$/g, '');
      const marker = fence(value, 3);
      const index = codeBlocks.push(`${marker}\n${value}\n${marker}`) - 1;
      return `\n\n\0SOVRAN_CODE_${index}\0\n\n`;
    }
    if (tag === 'code') {
      if (inPre) return children();
      const value = plain(node).replace(/\s+/g, ' ');
      const marker = fence(value, 1);
      return `${marker} ${value} ${marker}`;
    }
    if (tag === 'a') {
      const value = children().trim();
      try {
        const link = webUrl(new URL(node.attribs.href ?? '', url).href).href;
        if (links.size < WEB_LIMITS.links) links.add(link);
        return value ? `[${value}](<${link}>)` : '';
      } catch {
        return value;
      }
    }
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'li') return `\n- ${children().trim()}\n`;
    if (tag === 'tr') return `\n| ${children().replace(/\s+/g, ' ').trim()}\n`;
    if (tag === 'td' || tag === 'th') return `${children().trim().replace(/\|/g, '\\|')} | `;
    if (tag === 'table') {
      const rows = children()
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const count = rows[0]?.split('|').length ?? 2;
      if (rows.length)
        rows.splice(1, 0, `| ${Array.from({ length: Math.max(1, count - 2) }, () => '---').join(' | ')} |`);
      return `\n\n${rows.join('\n')}\n\n`;
    }
    if (tag === 'img') return node.attribs.alt ? escape(node.attribs.alt) : '';
    const value = children();
    return BLOCK.has(tag) ? `\n\n${value.trim()}\n\n` : value;
  };
  const root = main ?? article ?? body;
  const text = (root ? render(root) : doc.children.map((node) => render(node)).join(''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\0SOVRAN_CODE_(\d+)\0/g, (_marker, index: string) => codeBlocks[Number(index)] ?? '');
  return {
    title,
    text: text.slice(0, maxChars),
    links: [...links],
    truncated: limited || text.length > maxChars,
  };
}
