import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  generateTitle,
  TITLE_MAX_TOKENS,
  TITLE_SYSTEM_PROMPT,
} from '../../src/core/sessions/titles';
import { ScriptedProvider, text } from '../fixtures/fakes';

describe('chat titles', () => {
  it('cleans the decorations small models add', () => {
    expect(cleanTitle('Title: "Fix the login redirect".')).toBe('Fix the login redirect');
    expect(cleanTitle('**Configurare il TTL della sessione**')).toBe('Configurare il TTL della sessione');
    expect(cleanTitle('# Add tests for billing webhooks\n\nThis title captures…')).toBe(
      'Add tests for billing webhooks',
    );
    expect(cleanTitle('<think>The user wants a refactor.</think>\nRefactor the HTTP client')).toBe(
      'Refactor the HTTP client',
    );
    expect(cleanTitle('«Spiega il retry»')).toBe('Spiega il retry');
    expect(cleanTitle('   \n  ')).toBeNull();
    expect(cleanTitle('""')).toBeNull();
    expect(cleanTitle('x'.repeat(100))).toHaveLength(60);
  });

  it('asks for a short, tool-free reply and keeps only the first line', async () => {
    const provider = new ScriptedProvider([
      [text('Session TTL '), text('from env\nBecause the user…'), text(' more text')],
    ]);
    const title = await generateTitle(
      provider,
      { id: 'small' },
      'Make the session TTL configurable through SESSION_TTL',
      new AbortController().signal,
    );
    expect(title).toBe('Session TTL from env');
    const [req] = provider.requests;
    expect(req!.model).toBe('small');
    expect(req!.tools).toBeUndefined();
    // Room for models that reason before answering; reading still stops at the first line.
    expect(req!.maxTokens).toBe(TITLE_MAX_TOKENS);
    expect(req!.messages[0]).toEqual({ role: 'system', content: TITLE_SYSTEM_PROMPT });
    expect(req!.messages[1]!.content).toContain('Make the session TTL configurable');
  });

  it('sends at most the beginning and end of a very long first message', async () => {
    const provider = new ScriptedProvider([[text('Analyze the log')]]);
    await generateTitle(
      provider,
      { id: 'm' },
      `start ${'x'.repeat(50_000)} end`,
      new AbortController().signal,
    );
    const sent = String(provider.requests[0]!.messages[1]!.content);
    expect(sent.length).toBeLessThan(2500);
    expect(sent).toContain('start');
    expect(sent).toContain('end');
  });

  it('names the chat with a model that always reasons first (reasoning_content, then the answer)', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', text: 'The user wants the TTL to come from the environment. ' },
        { type: 'reasoning', text: 'A short title…' },
        text('TTL della sessione da env'),
      ],
    ]);
    expect(
      await generateTitle(
        provider,
        { id: 'glm-5.3-flash' },
        'Rendi il TTL configurabile',
        new AbortController().signal,
      ),
    ).toBe('TTL della sessione da env');
  });

  it('stops reading a reply that never breaks the line', async () => {
    const provider = new ScriptedProvider([
      [text('x'.repeat(150)), text('y'.repeat(150)), text('never read')],
    ]);
    const title = await generateTitle(provider, { id: 'm' }, 'hi', new AbortController().signal);
    expect(title).toHaveLength(60);
    expect(title).not.toContain('y');
  });

  it('ignores reasoning and returns null when no title is left', async () => {
    const provider = new ScriptedProvider([[text('<think>hmm, what should'), text(' I call it</think>')]]);
    expect(await generateTitle(provider, { id: 'm' }, 'hi', new AbortController().signal)).toBeNull();
  });

  it('lets server errors reach the caller', async () => {
    const provider = new ScriptedProvider([new Error('503 Service Unavailable')]);
    await expect(generateTitle(provider, { id: 'm' }, 'hi', new AbortController().signal)).rejects.toThrow(
      '503',
    );
  });
});
