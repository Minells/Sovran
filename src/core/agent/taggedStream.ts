export interface Segment {
  kind: 'text' | string;
  text: string;
}

/**
 * Incrementally splits streamed model text into plain text and tagged regions
 * (`<think>…</think>`, `<tool_call>…</tool_call>`), even when tags are split across chunks.
 *
 * - `stream` tags emit their inner text as it arrives (e.g. reasoning).
 * - `block` tags emit their inner text once, when the closing tag arrives (e.g. tool calls).
 *   An unterminated block at end of stream is still emitted by `flush()`.
 */
export class TaggedStreamParser {
  private buffer = '';
  private current: string | null = null;
  private blockText = '';

  constructor(private readonly tags: Record<string, 'stream' | 'block'>) {}

  push(chunk: string): Segment[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): Segment[] {
    return this.drain(true);
  }

  private drain(final: boolean): Segment[] {
    const out: Segment[] = [];
    const emit = (kind: string, text: string) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.text += text;
      else out.push({ kind, text });
    };

    for (;;) {
      if (this.current === null) {
        const open = this.findOpen();
        if (open) {
          emit('text', this.buffer.slice(0, open.index));
          this.buffer = this.buffer.slice(open.index + open.tag.length + 2);
          this.current = open.tag;
          this.blockText = '';
          continue;
        }
        const keep = final ? 0 : this.partialSuffix(Object.keys(this.tags).map((t) => `<${t}>`));
        emit('text', this.buffer.slice(0, this.buffer.length - keep));
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return out;
      }

      const tag = this.current;
      const close = `</${tag}>`;
      const idx = this.buffer.indexOf(close);
      const mode = this.tags[tag];
      if (idx !== -1) {
        const inner = this.buffer.slice(0, idx);
        if (mode === 'block') emit(tag, this.blockText + inner);
        else emit(tag, inner);
        this.buffer = this.buffer.slice(idx + close.length);
        this.current = null;
        this.blockText = '';
        continue;
      }
      const keep = final ? 0 : this.partialSuffix([close]);
      const available = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (mode === 'block') {
        this.blockText += available;
        if (final) {
          emit(tag, this.blockText);
          this.blockText = '';
          this.current = null;
        }
      } else {
        emit(tag, available);
      }
      return out;
    }
  }

  private findOpen(): { index: number; tag: string } | null {
    let best: { index: number; tag: string } | null = null;
    for (const tag of Object.keys(this.tags)) {
      const index = this.buffer.indexOf(`<${tag}>`);
      if (index !== -1 && (!best || index < best.index)) best = { index, tag };
    }
    return best;
  }

  /** Length of the longest buffer suffix that is a proper prefix of any marker. */
  private partialSuffix(markers: string[]): number {
    let keep = 0;
    for (const marker of markers) {
      for (let len = Math.min(marker.length - 1, this.buffer.length); len > keep; len--) {
        if (this.buffer.endsWith(marker.slice(0, len))) {
          keep = len;
          break;
        }
      }
    }
    return keep;
  }
}
