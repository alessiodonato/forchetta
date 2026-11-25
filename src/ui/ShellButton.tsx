import type { Agent } from '../shared/agent.ts';
import type { Store } from './store.ts';

/** "shell" in a box or in the head of a pane: a plain terminal in its folder. On Windows, one button for each kind. */
export function ShellButton({ agent, store, className = 'files-button' }: { agent: Agent; store: Store; className?: string }) {
  const kinds = store.state.shellKinds;
  if (!kinds || kinds.length === 0 || !agent.cwd) return null;
  return (
    <>
      {kinds.map((kind) => (
        <button
          key={kind.id}
          type="button"
          class={className}
          title={`A plain terminal (${kind.label}) in ${agent.cwd}, with no Claude in it`}
          onClick={(event) => {
            event.stopPropagation();
            store.openShell(agent.id, kind.id);
          }}
        >
          {kinds.length > 1 ? kind.label : 'shell'}
        </button>
      ))}
    </>
  );
}
