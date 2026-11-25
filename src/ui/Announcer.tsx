import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { announcements } from './announce.ts';

// A live region, out of sight: VoiceOver reads what is written in it, politely (after what it is reading now).
// It says when a session starts waiting for you (announce.ts), once.

export function Announcer({ agents, said: note }: { agents: readonly Agent[]; said?: { text: string; at: number } }) {
  const waiting = useRef<Map<string, string> | undefined>(undefined);
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [text, setText] = useState('');
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const { said, next } = announcements(waiting.current ?? new Map(), agents, waiting.current === undefined);
    waiting.current = next;
    if (said.length === 0) return;
    pending.current.push(...said);
    // Emptied first, then written: the same sentence twice in a row is read twice.
    setText('');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setText(pending.current.join('. '));
      pending.current = [];
    }, 50);
  }, [agents]);
  useEffect(() => {
    if (!note) return;
    setText('');
    const later = setTimeout(() => setText(note.text), 50);
    return () => clearTimeout(later);
  }, [note?.at]);
  return (
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
