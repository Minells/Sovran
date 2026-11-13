import { escapeAttribute, formatToolResult, neutralizeClosingTags, serializeToolCall } from '../agent/promptedTools';
import { dimensions, estimateImageTokens, IMAGE_LABELS } from '../images/images';
import type { ResolvedToolMode, WireContentPart, WireMessage } from '../providers/types';
import type {
  ContextAttachment,
  ContextBreakdown,
  ImageAttachment,
  SessionMessage,
  ToolMessage,
} from '../sessions/model';
import { truncateMiddle } from '../tools/edits';
import { FORMAT_LABELS } from '../documents/types';

/** Tells the model what a converted document's Markdown is (the value of the `note` attribute). */
export const DOCUMENT_NOTE = 'Text extracted from the file by Sovran. Images, charts and page layout are not included.';

/** Conservative estimate: code tokenizes densely, so ~3.5 chars/token rather than the usual 4. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

/** Token estimates of the image parts built for a request (the parts themselves only carry a data URL). */
const imageTokens = new WeakMap<WireContentPart, number>();

function contentTokens(content: string | WireContentPart[] | null): number {
  if (content === null) return 0;
  if (typeof content === 'string') return estimateTokens(content);
  return content.reduce((n, p) => n + (p.type === 'text' ? estimateTokens(p.text) : (imageTokens.get(p) ?? 1600)), 0);
}

export function wireTokens(m: WireMessage): number {
  let n = 4 + contentTokens(m.content);
  if (m.role === 'assistant' && m.tool_calls) {
    for (const c of m.tool_calls) n += 8 + estimateTokens(c.function.name + c.function.arguments);
  }
  return n;
}

export function renderAttachments(attachments: readonly ContextAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  const blocks = attachments.map((a) => {
    const lines = a.startLine ? ` lines="${a.startLine}-${a.endLine ?? a.startLine}"` : '';
    // A converted document says what it was and what the conversion leaves out, so the model neither mistakes the
    // Markdown for the file's own text nor guesses at figures it cannot see.
    const label = a.format ? FORMAT_LABELS[a.format] : undefined;
    const doc = label
      ? ` format="${escapeAttribute(label)}"${a.detail ? ` detail="${escapeAttribute(a.detail)}"` : ''} note="${DOCUMENT_NOTE}"`
      : '';
    const note = a.truncated ? ' truncated="true"' : '';
    return `<file path="${escapeAttribute(a.path)}"${lines}${doc}${note}>\n${neutralizeClosingTags(a.content, ['file', 'context'])}\n</file>`;
  });
  return `<context>\n${blocks.join('\n')}\n</context>\n\n`;
}

/**
 * How an image is named to the model, before the image itself, so it can tell several apart ("the second
 * screenshot"). When the image is not sent, `missing` says why, and the label stands in for it.
 */
export function imageLabel(img: ImageAttachment, missing?: 'unsupported' | 'unavailable'): string {
  const size = dimensions(img);
  const note =
    missing === 'unsupported'
      ? ' note="Not sent: this model does not accept images. Say so if the answer depends on it."'
      : missing === 'unavailable'
        ? ' note="Not sent: the image is no longer available."'
        : '';
  return `<image name="${escapeAttribute(img.name)}" type="${IMAGE_LABELS[img.mime] ?? 'image'}"${size ? ` size="${size}"` : ''}${note}/>`;
}

/**
 * The content of a user message. Without images it is the plain string it always was; with images it becomes parts:
 * each image after its label, then the text. Images the model cannot receive (or that are gone) leave only their label.
 */
function userContent(text: string, images: readonly ImageAttachment[] | undefined, o: Pick<BuildContextOptions, 'images' | 'vision'>): string | WireContentPart[] {
  if (!images?.length) return text;
  const parts: WireContentPart[] = [];
  const labels: string[] = [];
  for (const img of images) {
    const url = o.vision ? o.images?.get(img.id) : undefined;
    if (!url) {
      labels.push(imageLabel(img, o.vision ? 'unavailable' : 'unsupported'));
      continue;
    }
    const part: WireContentPart = { type: 'image_url', image_url: { url } };
    imageTokens.set(part, estimateImageTokens(img));
    parts.push({ type: 'text', text: imageLabel(img) }, part);
  }
  const rest = labels.length ? `${labels.join('\n')}\n\n${text}` : text;
  if (!parts.length) return rest;
  parts.push({ type: 'text', text: rest });
  return parts;
}

export interface BuildContextOptions {
  systemPrompt: string;
  messages: readonly SessionMessage[];
  toolMode: ResolvedToolMode;
  /** Tokens available for prompt (context window minus output reserve). */
  budgetTokens: number;
  /** Tokens consumed by tool schemas sent alongside the messages. */
  toolSchemaTokens: number;
  maxToolResultChars: number;
  /** Summary of compacted earlier conversation, injected into the system prompt. */
  summary?: string;
  /** Data URLs of the images user messages carry, by image id. An image missing here is sent as its label only. */
  images?: ReadonlyMap<string, string>;
  /** Whether the model receives images. When false, each image is sent as its label only. */
  vision?: boolean;
}

export interface BuildContextResult {
  messages: WireMessage[];
  estimatedTokens: number;
  /** `estimatedTokens` by part. Tools counts the schemas sent alongside the messages only. */
  breakdown: ContextBreakdown;
  droppedTurns: number;
  elidedResults: number;
}

const ELIDED = '[Earlier tool output removed to fit the context window. Re-run the tool if you need it again.]';

/** Converts canonical session messages to the wire format for a tool mode, keeping the protocol valid. */
function toWire(
  messages: readonly SessionMessage[],
  toolMode: ResolvedToolMode,
  maxToolResultChars: number,
  media: Pick<BuildContextOptions, 'images' | 'vision'> = {},
): WireMessage[][] {
  const turns: WireMessage[][] = [];
  let turn: WireMessage[] = [];
  const results = new Map(messages.filter((m): m is ToolMessage => m.role === 'tool').map((m) => [m.toolCallId, m]));

  const pushUserText = (text: string) => {
    const last = turn[turn.length - 1];
    // Prompted mode: merge consecutive user-role messages; many chat templates require strict alternation.
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') last.content += `\n\n${text}`;
      else last.content.push({ type: 'text', text: `\n\n${text}` });
    } else turn.push({ role: 'user', content: text });
  };

  for (const m of messages) {
    if (m.role === 'user') {
      if (turn.length) turns.push(turn);
      turn = [{ role: 'user', content: userContent(renderAttachments(m.attachments) + m.content, m.images, media) }];
      continue;
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      if (!m.content.trim() && calls.length === 0) continue;
      if (toolMode === 'native') {
        turn.push({
          role: 'assistant',
          content: m.content || null,
          ...(calls.length
            ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } })) }
            : {}),
        });
        // Every native tool call must be answered, even if the result was lost (e.g. interrupted run).
        for (const c of calls) {
          const r = results.get(c.id);
          turn.push({
            role: 'tool',
            tool_call_id: c.id,
            content: truncateMiddle(r?.content ?? 'No result: the action did not run.', maxToolResultChars),
          });
        }
      } else {
        const text = [m.content, ...calls.map((c) => serializeToolCall(c.name, c.arguments))].filter(Boolean).join('\n\n');
        turn.push({ role: 'assistant', content: text });
        for (const c of calls) {
          const r = results.get(c.id);
          pushUserText(
            formatToolResult(c.name, c.id, truncateMiddle(r?.content ?? 'No result: the action did not run.', maxToolResultChars), r?.status ?? 'cancelled'),
          );
        }
      }
    }
    // Tool messages are emitted together with their assistant message above.
  }
  if (turn.length) turns.push(turn);
  return turns;
}

const sum = (msgs: WireMessage[]) => msgs.reduce((n, m) => n + wireTokens(m), 0);

/**
 * Builds the request messages within a token budget:
 * 1) elide tool output outside the last two turns, 2) drop oldest whole turns,
 * 3) shrink the largest remaining tool results. The latest turn is always kept.
 */
export function buildContext(o: BuildContextOptions): BuildContextResult {
  const turns = toWire(o.messages, o.toolMode, o.maxToolResultChars, o);
  const system: WireMessage = {
    role: 'system',
    content: o.summary ? `${o.systemPrompt}\n\n# Summary of the earlier conversation\n${o.summary}` : o.systemPrompt,
  };
  const fixed = wireTokens(system) + o.toolSchemaTokens;
  const total = () => fixed + turns.reduce((n, t) => n + sum(t), 0);
  let elidedResults = 0;
  let droppedTurns = 0;

  // Tool results are always plain strings (only the user's own messages carry images).
  const isToolResult = (m: WireMessage): m is Extract<WireMessage, { role: 'tool' | 'user' }> & { content: string } =>
    typeof m.content === 'string' && (m.role === 'tool' || (m.role === 'user' && m.content.includes('<tool_result')));

  if (total() > o.budgetTokens) {
    for (let i = 0; i < turns.length - 2; i++) {
      for (const m of turns[i] ?? []) {
        if (isToolResult(m) && (m.content?.length ?? 0) > ELIDED.length) {
          m.content = ELIDED;
          elidedResults++;
        }
      }
    }
  }
  while (total() > o.budgetTokens && turns.length > 1) {
    turns.shift();
    droppedTurns++;
  }
  if (total() > o.budgetTokens) {
    const last = turns[turns.length - 1] ?? [];
    const candidates = last.filter(isToolResult).sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0));
    for (const m of candidates) {
      if (total() <= o.budgetTokens) break;
      m.content = truncateMiddle(m.content ?? '', 2000);
    }
  }

  if (droppedTurns > 0) {
    system.content += `\n\nNote: ${droppedTurns} earlier exchange(s) were omitted to fit the context window.`;
  }
  const messages = [system, ...turns.flat()];
  const estimatedTokens = total();
  const breakdown = { system: fixed - o.toolSchemaTokens, tools: o.toolSchemaTokens, messages: estimatedTokens - fixed };
  return { messages, estimatedTokens, breakdown, droppedTurns, elidedResults };
}
