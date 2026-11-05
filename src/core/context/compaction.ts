import { TaggedStreamParser } from '../agent/taggedStream';
import type { ChatProvider, ModelConfig } from '../providers/types';
import type { SessionMessage } from '../sessions/model';
import { truncateMiddle } from '../tools/edits';

export const SUMMARY_SYSTEM_PROMPT = `You compress the history of a coding-agent conversation so the agent can continue the task with a smaller context.
Write a factual summary in Markdown with exactly these sections:
## Goal
## Decisions and constraints
## Files read or changed (paths, and what changed)
## Current state
## Open tasks
Rules: keep exact file paths, identifiers, commands and error messages that matter; drop pleasantries and repeated tool output; never invent facts; at most 400 words.`;

/**
 * Chooses which prefix of the conversation to summarize: everything before the last `keepTurns` user turns.
 * Returns null when there is nothing worth compacting. Always cuts at a user message, so tool calls and
 * their results are never split.
 */
export function planCompaction(messages: readonly SessionMessage[], keepTurns = 2): { firstKeptIndex: number } | null {
  const userIdx = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  if (userIdx.length <= keepTurns) return null;
  const firstKeptIndex = userIdx[userIdx.length - keepTurns]!;
  return firstKeptIndex > 0 ? { firstKeptIndex } : null;
}

/** Renders messages as a compact plain-text transcript for the summarizer, within a character budget. */
export function renderForSummary(messages: readonly SessionMessage[], previousSummary: string | undefined, maxChars: number): string {
  const lines: string[] = [];
  if (previousSummary) lines.push(`PREVIOUS SUMMARY:\n${previousSummary}\n`);
  for (const m of messages) {
    if (m.role === 'user') {
      const files = [...(m.attachments?.map((a) => a.path) ?? []), ...(m.images?.map((i) => `${i.name} (image)`) ?? [])].join(', ');
      lines.push(`USER: ${m.content}${files ? `\n(attached: ${files})` : ''}`);
    } else if (m.role === 'assistant') {
      if (m.content.trim()) lines.push(`ASSISTANT: ${m.content.trim()}`);
      for (const c of m.toolCalls ?? []) lines.push(`ASSISTANT CALLED ${c.name}(${truncateMiddle(c.arguments, 300)})`);
      if (m.error) lines.push(`ERROR: ${m.error.message}`);
    } else {
      lines.push(`RESULT of ${m.toolName} [${m.status}]: ${truncateMiddle(m.content, 600)}`);
    }
  }
  return truncateMiddle(lines.join('\n'), Math.max(2000, maxChars));
}

/** Runs a tool-free completion that summarizes the transcript. */
export async function summarize(provider: ChatProvider, model: ModelConfig, transcript: string, signal: AbortSignal): Promise<string> {
  const parser = new TaggedStreamParser({ think: 'stream' });
  let text = '';
  const take = (segments: { kind: string; text: string }[]) => {
    for (const s of segments) if (s.kind === 'text') text += s.text;
  };
  for await (const ev of provider.streamChat(
    {
      model: model.id,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: `Summarize this conversation:\n\n${transcript}` },
      ],
      maxTokens: 1200,
    },
    signal,
  )) {
    if (ev.type === 'text') take(parser.push(ev.text));
  }
  take(parser.flush());
  const summary = text.trim();
  if (!summary) throw new Error('The model returned an empty summary.');
  return summary;
}
