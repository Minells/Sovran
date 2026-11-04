import { TaggedStreamParser } from '../agent/taggedStream';
import type { ChatProvider, ModelConfig } from '../providers/types';
import { truncateMiddle } from '../tools/edits';

export const TITLE_SYSTEM_PROMPT = `You name chat conversations with a coding assistant.
Reply with a short title, 2 to 6 words, that says what the user wants. Write it in the language of the user's message.
Reply with the title only: no quotes, no markdown, no trailing punctuation, no explanation.`;

const MAX_TITLE = 60;
/**
 * A cap, not a cost: a plain model writes a few words and stops, and reading stops at the first line anyway. Models that
 * always reason (GLM, DeepSeek-R1, Qwen3 in thinking mode) spend this same budget on reasoning before they answer, so
 * a tight cap (a few dozen tokens) leaves them no room for the title.
 */
export const TITLE_MAX_TOKENS = 1024;
/** A reply this long without a line break is not a title; stop reading and keep what is there. */
const MAX_REPLY_CHARS = 200;
/** The first message is enough to name a chat; a pasted log would only cost time on a slow local model. */
const MAX_INPUT_CHARS = 2000;

/**
 * Turns a model reply into a clean title, or null when nothing usable is left. Small models often add a "Title:"
 * prefix, quotes, bold markers or a final period, and reasoning models may leak a `<think>` block.
 */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  let title = line
    .replace(/^#+\s*/, '')
    .replace(/^(chat\s+)?title\s*[:\-–]\s*/i, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ');
  // Quotes and final punctuation come in any order ("Title". or "Title.") — strip both until nothing changes.
  for (let prev = ''; prev !== title;) {
    prev = title;
    title = title
      .trim()
      .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
      .replace(/[.:;,!]+$/, '');
  }
  if (!title) return null;
  if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
  return title;
}

/**
 * Asks the model for a short title for a chat that starts with `firstMessage`. Tool-free, a few tokens long, and
 * stops reading as soon as the first line is complete. Returns null when the reply has no usable title; network and
 * server errors are thrown so the caller can log them.
 */
export async function generateTitle(
  provider: ChatProvider,
  model: ModelConfig,
  firstMessage: string,
  signal: AbortSignal,
): Promise<string | null> {
  const parser = new TaggedStreamParser({ think: 'stream' });
  let text = '';
  const take = (segments: { kind: string; text: string }[]) => {
    for (const s of segments) if (s.kind === 'text') text += s.text;
  };
  for await (const ev of provider.streamChat(
    {
      model: model.id,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Name the chat that starts with this message:\n\n${truncateMiddle(firstMessage, MAX_INPUT_CHARS)}`,
        },
      ],
      maxTokens: TITLE_MAX_TOKENS,
      temperature: 0.2,
    },
    signal,
  )) {
    if (ev.type === 'text') take(parser.push(ev.text));
    // One line is all we need; leaving the loop closes the stream.
    if (/\S[^\n]*\n/.test(text) || text.length > MAX_REPLY_CHARS) break;
  }
  take(parser.flush());
  return cleanTitle(text);
}
