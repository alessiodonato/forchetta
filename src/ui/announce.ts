import { type Agent, displayName, STATE_LABEL } from '../shared/agent.ts';
import { waitingText } from '../shared/present.ts';

// What a screen reader is told. A box, when the keyboard reaches it: the session, its state, what it does. And without
// looking: a session that starts waiting for you. Said once, when it starts waiting (or waits for something else), not
// at every change of the page; the sessions already waiting when the page opens are in the top line, and are not read
// out one by one.

/** What a session waits for: the key of one announcement. */
const waitKey = (agent: Agent): string | undefined => (agent.state === 'waiting' ? `${agent.waiting?.kind ?? ''}|${agent.waiting?.detail ?? ''}|${agent.waiting?.tool ?? ''}` : undefined);

/** The sentence for one session: "checkout waits for you: Permission: npm test". */
export const waitSentence = (agent: Agent): string => `${displayName(agent)} waits for you: ${waitingText(agent)}`;

/**
 * The sentences to say now, from what each session waited for before (`before`, by id) and the sessions now; and
 * what each one waits for now, for the next time. With `first`, nothing is said: only remembered.
 */
export function announcements(before: ReadonlyMap<string, string>, agents: Iterable<Agent>, first = false): { said: string[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const said: string[] = [];
  for (const agent of agents) {
    const key = waitKey(agent);
    if (key === undefined) continue;
    next.set(agent.id, key);
    if (!first && before.get(agent.id) !== key) said.push(waitSentence(agent));
  }
  return { said, next };
}

/** What a screen reader says of a box: the session, its state, what it does, and whether it opens. */
export function boxLabel(agent: Agent, line: string, openable: boolean): string {
  const what = line.trim();
  return `${displayName(agent)}, ${STATE_LABEL[agent.state]}${what ? `: ${what}` : ''}${openable || agent.state === 'ended' ? '' : ' (read only)'}`;
}
