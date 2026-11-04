import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { SessionMessage } from '../../../src/shared/protocol';

type UserMessage = Extract<SessionMessage, { role: 'user' }>;

/** Where a pinned message sits in the view, like the message itself before it scrolled away. */
const PIN_TOP = 8;
/**
 * Where "go to this message" leaves the message: just below PIN_TOP, as far from the edge as the conversation's own
 * padding, so the message is read whole and not pinned again over itself.
 */
const JUMP_TOP = 12;
/** Space kept between the pin and the next message pushing it out. */
const PIN_GAP = 8;
/** Used until the pin has been measured once. */
const DEFAULT_PIN_HEIGHT = 64;

export interface Pinned {
  id: string;
  /** How far the next message has pushed the pin up (0 or negative, in px). */
  offset: number;
}

/**
 * The message to pin at the top of the conversation: the last one of yours whose top has reached the top of the view,
 * so the answer being read is always under the question that started it. The next message pushes the pin out as it
 * arrives, so where each exchange ends stays visible. Null when no message of yours has reached the top.
 *
 * It works like `position: sticky` on each message, but as a separate pin: a long message is shown in two lines, and
 * nothing in the conversation changes size or moves while it scrolls.
 */
export function pickPinned(scroller: HTMLElement, pinHeight: number): Pinned | null {
  const top = scroller.getBoundingClientRect().top;
  let current: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-user-message]')) {
    if (el.getBoundingClientRect().top <= top + PIN_TOP) current = el;
    else {
      next = el;
      break;
    }
  }
  if (!current?.dataset.userMessage) return null;
  const offset = next ? Math.min(0, next.getBoundingClientRect().top - (top + pinHeight + PIN_GAP)) : 0;
  // Pushed out far enough that only its bottom padding would show: gone.
  if (pinHeight + offset <= PIN_GAP) return null;
  return { id: current.dataset.userMessage, offset: Math.round(offset) };
}

/**
 * Your message pinned at the top of the conversation while its answer scrolls by. It follows the scroll by itself:
 * the conversation is not rendered again on every frame, and the push-out offset is applied directly to the element.
 * Selecting it scrolls back to the message.
 */
export function StickyPrompt({ scrollerRef, messages }: { scrollerRef: RefObject<HTMLDivElement | null>; messages: readonly UserMessage[] }) {
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  // Re-measure when messages are added or removed (edit, retry), not on every streamed chunk.
  const ids = messages.map((m) => m.id).join(' ');

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const pick = pickPinned(scroller, ref.current?.offsetHeight || DEFAULT_PIN_HEIGHT);
      offset.current = pick?.offset ?? 0;
      if (ref.current) ref.current.style.transform = offset.current ? `translateY(${offset.current}px)` : '';
      setPinnedId(pick?.id ?? null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(scroller);
    schedule();
    return () => {
      scroller.removeEventListener('scroll', schedule);
      resize?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollerRef, ids]);

  // A pin that just appeared starts where the next message has already pushed it.
  useLayoutEffect(() => {
    if (ref.current) ref.current.style.transform = offset.current ? `translateY(${offset.current}px)` : '';
  }, [pinnedId]);

  const message = pinnedId ? messages.find((m) => m.id === pinnedId) : undefined;
  if (!message) return null;
  const text = message.display ?? message.content;

  const jump = () => {
    const scroller = scrollerRef.current;
    const target = [...(scroller?.querySelectorAll<HTMLElement>('[data-user-message]') ?? [])].find((el) => el.dataset.userMessage === message.id);
    if (!scroller || !target) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - JUMP_TOP;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <div className="sv-pin" ref={ref}>
      <button type="button" className="sv-pin__card" title="Go to this message" aria-label={`Your message: ${text.slice(0, 200)}. Go to it`} onClick={jump}>
        <span className="sv-pin__text">{text}</span>
      </button>
    </div>
  );
}
