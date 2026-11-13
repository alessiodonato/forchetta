import type { Agent, GuardHold } from '../shared/agent.ts';
import type { Store } from './store.ts';

// The lines of the guard in a box (daemon/guard.ts): the file this session was stopped on, who is changing it,
// and the button that lets it through; the files of its turn that keep other sessions waiting.

/** "beta", "beta and gamma", "beta, gamma and delta". */
function names(list: string[]): string {
  const unique = [...new Set(list)];
  return unique.length <= 1 ? (unique[0] ?? '') : `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)!}`;
}

const more = (holds: readonly GuardHold[]): string => (holds.length > 1 ? ` · +${holds.length - 1}` : '');

/** The file a session was stopped on, for its box and its tooltip. */
export function heldBackText(hold: GuardHold): string {
  return hold.letThrough ? `${hold.file}: let through, ${hold.withName} changes it too` : `${hold.file} held by ${hold.withName}`;
}

export function holdingText(holding: readonly GuardHold[]): string {
  const files = [...new Set(holding.map((hold) => hold.file))];
  const waiting = holding.filter((hold) => !hold.letThrough).map((hold) => hold.withName);
  const who = waiting.length > 0 ? `${names(waiting)} ${new Set(waiting).size === 1 ? 'waits' : 'wait'}` : `shared with ${names(holding.map((hold) => hold.withName))}`;
  return `holds ${files[0]}${files.length > 1 ? ` +${files.length - 1}` : ''} · ${who}`;
}

export function GuardLines({ agent, store }: { agent: Agent; store: Store }) {
  const held = agent.heldBack;
  const holding = agent.holding;
  if (!held && !holding) return null;
  // The button must not open the box.
  const stop = (event: Event): void => event.stopPropagation();
  const first = held?.[0];
  return (
    <>
      {first && (
        <div
          class="guard-line"
          data-kind="held"
          onClick={stop}
          title={held!.map((hold) => `${hold.file}: ${hold.withName} is changing it in its turn${hold.letThrough ? ' (you let this session through)' : ''}`).join('\n')}
        >
          <span class="guard-mark">‖</span>
          <span class="guard-text">
            {heldBackText(first)}
            {more(held!)}
          </span>
          {!first.letThrough && (
            <button type="button" class="link" title={`Let this session write ${first.file} while ${first.withName} changes it too`} onClick={() => store.letThrough(agent.id, first.path)}>
              let it through
            </button>
          )}
        </div>
      )}
      {holding && (
        <div class="guard-line" data-kind="holding" title={holding.map((hold) => `${hold.withName} ${hold.letThrough ? 'shares' : 'waits for'} ${hold.file}`).join('\n')}>
          <span class="guard-mark">‖</span>
          <span class="guard-text">{holdingText(holding)}</span>
        </div>
      )}
    </>
  );
}
