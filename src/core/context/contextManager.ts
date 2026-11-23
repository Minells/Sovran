import { escapeAttribute, formatToolResult, neutralizeClosingTags, serializeToolCall } from '../agent/promptedTools';
import { dimensions, estimateImageTokens, IMAGE_LABELS } from '../images/images';
import type { ResolvedToolMode, WireContentPart, WireMessage } from '../providers/types';
import type {
  ContextAttachment,
  ContextBreakdown,
  ContextSource,
  ImageAttachment,
  SessionMessage,
  ToolMessage,
} from '../sessions/model';
import { truncateMiddle } from '../tools/edits';
import { FORMAT_LABELS } from '../documents/types';
import { redactKnown } from '../security/redact';

/** Tells the model what a converted document's Markdown is (the value of the `note` attribute). */
export const DOCUMENT_NOTE = 'Text extracted from the file by Sovran. Images, charts and page layout are not included.';

/** Conservative estimate: code tokenizes densely, so ~3.5 chars/token rather than the usual 4. */
export const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

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
  targeted?: { messageId: string; attachments: readonly ContextAttachment[] };
  secrets?: readonly (string | undefined)[];
}

export interface BuildContextResult {
  messages: WireMessage[];
  estimatedTokens: number;
  /** `estimatedTokens` by part. Tools counts the schemas sent alongside the messages only. */
  breakdown: ContextBreakdown;
  droppedTurns: number;
  elidedResults: number;
  sources: ContextSource[];
}

const ELIDED = '[Earlier tool output removed to fit the context window. Re-run the tool if you need it again.]';

function fitAttachments(o: BuildContextOptions, fixed: number): Map<string, ContextAttachment[]> {
  const output = new Map<string, ContextAttachment[]>();
  const recentUser = o.messages.findLastIndex((message) => message.role === 'user');
  const recentReads = o.messages.slice(recentUser + 1).flatMap((message) =>
    message.role === 'tool' && message.content.length <= Math.min(2000, o.maxToolResultChars)
      ? message.contextSources ?? [] : [],
  );
  const targeted = o.targeted?.attachments.filter((candidate) => !recentReads.some((source) =>
    source.origin === 'read-file' && source.path === candidate.path &&
    source.startLine !== undefined && candidate.startLine !== undefined &&
    source.endLine !== undefined && candidate.endLine !== undefined &&
    source.startLine <= candidate.startLine && source.endLine >= candidate.endLine,
  ));
  let remaining = Math.max(0, Math.floor((o.budgetTokens - fixed) * 0.35));
  for (const message of [...o.messages].reverse()) {
    if (message.role !== 'user' || remaining <= 0) continue;
    const attachments = message.attachments ?? [];
    const selected: ContextAttachment[] = [];
    const candidates = [
      ...attachments.filter((a) => a.origin !== 'editor'),
      ...(o.targeted?.messageId === message.id ? targeted ?? [] : []),
      ...attachments.filter((a) => a.origin === 'editor'),
    ];
    for (const candidate of candidates) {
      const startLine = candidate.format ? undefined : candidate.startLine ?? 1;
      const content = redactKnown(candidate.content, o.secrets);
      const endLine = startLine === undefined ? undefined : startLine + content.split(/\r?\n/).length - 1;
      if (selected.some((a) => a.path === candidate.path && (
        a.startLine === undefined || startLine === undefined ||
        (a.startLine <= endLine! && a.endLine! >= startLine)
      ))) continue;
      const attachment = { ...candidate, content, startLine, endLine, origin: candidate.origin ?? 'attachment' as const };
      const overhead = estimateTokens(renderAttachments([{ ...attachment, content: '' }])) + 8;
      const room = Math.floor((remaining - overhead) * CHARS_PER_TOKEN);
      if (room <= 0) continue;
      if (content.length > room) {
        attachment.content = content.slice(0, room);
        attachment.endLine = startLine === undefined ? undefined : startLine + attachment.content.split(/\r?\n/).length - 1;
        attachment.truncated = true;
      }
      while (estimateTokens(renderAttachments([attachment])) > remaining && attachment.content.length > 0) {
        attachment.content = attachment.content.slice(0, Math.floor(attachment.content.length * 0.8));
        attachment.endLine = startLine === undefined ? undefined : startLine + attachment.content.split(/\r?\n/).length - 1;
        attachment.truncated = true;
      }
      if (!attachment.content && content) continue;
      selected.push(attachment);
      remaining -= estimateTokens(renderAttachments([attachment]));
    }
    output.set(message.id, selected);
  }
  return output;
}

/** Converts canonical session messages to the wire format for a tool mode, keeping the protocol valid. */
function toWire(
  messages: readonly SessionMessage[],
  toolMode: ResolvedToolMode,
  maxToolResultChars: number,
  media: Pick<BuildContextOptions, 'images' | 'vision'>,
  attachments: ReadonlyMap<string, ContextAttachment[]>,
  sources: Map<WireMessage, ContextSource[]>,
  toolWires: Set<WireMessage>,
): WireMessage[][] {
  const turns: WireMessage[][] = [];
  let turn: WireMessage[] = [];
  const results = new Map(messages.filter((m): m is ToolMessage => m.role === 'tool').map((m) => [m.toolCallId, m]));

  const pushUserText = (text: string, entries: readonly ContextSource[]) => {
    const last = turn[turn.length - 1];
    // Prompted mode: merge consecutive user-role messages; many chat templates require strict alternation.
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') last.content += `\n\n${text}`;
      else last.content.push({ type: 'text', text: `\n\n${text}` });
      if (entries.length) sources.set(last, [...(sources.get(last) ?? []), ...entries]);
    } else {
      const wire: WireMessage = { role: 'user', content: text };
      toolWires.add(wire);
      if (entries.length) sources.set(wire, [...entries]);
      turn.push(wire);
    }
  };

  for (const m of messages) {
    if (m.role === 'user') {
      if (turn.length) turns.push(turn);
      const selected = attachments.get(m.id) ?? [];
      const wire: WireMessage = { role: 'user', content: userContent(renderAttachments(selected) + m.content, m.images, media) };
      sources.set(wire, selected.map(({ path, startLine, endLine, origin, detail, truncated, external }) => ({
        path, startLine, endLine, origin, detail, truncated, external,
      })));
      turn = [wire];
      continue;
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      if (!m.content.trim() && calls.length === 0) continue;
      if (toolMode === 'native') {
        const previous = turn.at(-1);
        const content = previous?.role === 'assistant' && !previous.tool_calls?.length
          ? [turn.pop()?.content, m.content].filter(Boolean).join('\n\n') : m.content;
        turn.push({
          role: 'assistant',
          content: content || null,
          ...(calls.length
            ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } })) }
            : {}),
        });
        // Every native tool call must be answered, even if the result was lost (e.g. interrupted run).
        for (const c of calls) {
          const r = results.get(c.id);
          const wire: WireMessage = {
            role: 'tool',
            tool_call_id: c.id,
            content: truncateMiddle(r?.content ?? 'No result: the action did not run.', maxToolResultChars),
          };
          if (r?.contextSources && r.content.length <= maxToolResultChars) sources.set(wire, r.contextSources);
          toolWires.add(wire);
          turn.push(wire);
        }
      } else {
        const text = [m.content, ...calls.map((c) => serializeToolCall(c.name, c.arguments))].filter(Boolean).join('\n\n');
        const previous = turn.at(-1);
        if (previous?.role === 'assistant') previous.content = [previous.content, text].filter(Boolean).join('\n\n');
        else turn.push({ role: 'assistant', content: text });
        for (const c of calls) {
          const r = results.get(c.id);
          pushUserText(
            formatToolResult(c.name, c.id, truncateMiddle(r?.content ?? 'No result: the action did not run.', maxToolResultChars), r?.status ?? 'cancelled'),
            r && r.content.length <= maxToolResultChars ? r.contextSources ?? [] : [],
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
  const system: WireMessage = {
    role: 'system',
    content: o.summary ? `${o.systemPrompt}\n\n# Summary of the earlier conversation\n${o.summary}` : o.systemPrompt,
  };
  const fixed = wireTokens(system) + o.toolSchemaTokens;
  const sourceByMessage = new Map<WireMessage, ContextSource[]>();
  const toolWires = new Set<WireMessage>();
  const turns = toWire(o.messages, o.toolMode, o.maxToolResultChars, o, fitAttachments(o, fixed), sourceByMessage, toolWires);
  const total = () => fixed + turns.reduce((n, t) => n + sum(t), 0);
  let elidedResults = 0;
  let droppedTurns = 0;

  // Tool results are always plain strings (only the user's own messages carry images).
  const isToolResult = (m: WireMessage): m is Extract<WireMessage, { role: 'tool' | 'user' }> & { content: string } =>
    typeof m.content === 'string' && toolWires.has(m);

  if (total() > o.budgetTokens) {
    for (let i = 0; i < turns.length - 2; i++) {
      for (const m of turns[i] ?? []) {
        if (isToolResult(m) && (m.content?.length ?? 0) > ELIDED.length) {
          m.content = ELIDED;
          sourceByMessage.delete(m);
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
      const shortened = truncateMiddle(m.content ?? '', 2000);
      if (shortened !== m.content) sourceByMessage.delete(m);
      m.content = shortened;
    }
  }

  if (droppedTurns > 0) {
    system.content += `\n\nNote: ${droppedTurns} earlier exchange(s) were omitted to fit the context window.`;
  }
  const messages = [system, ...turns.flat()];
  const estimatedTokens = total();
  const breakdown = { system: fixed - o.toolSchemaTokens, tools: o.toolSchemaTokens, messages: estimatedTokens - fixed };
  const sources = messages.flatMap((m) => sourceByMessage.get(m) ?? []);
  return { messages, estimatedTokens, breakdown, droppedTurns, elidedResults, sources };
}
