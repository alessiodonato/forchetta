import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { recentFolders } from './NewSession.tsx';
import type { Store } from './store.ts';

// Search in the earlier sessions of a project: what was asked, decided and changed. arricurdAI searches
// (`arricurdai recall`, daemon/recall.ts) and hides secrets; the panel shows what it found, in the order of
// arricurdAI: the most relevant first.

const lastPart = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

function when(at: number | undefined): string {
  if (at === undefined) return '';
  return new Date(at).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function RecallPanel({ agents, store, onClose }: { agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const folders = useMemo(() => recentFolders(agents, 8), [agents]);
  const [project, setProject] = useState(store.state.recall?.project ?? folders[0] ?? '');
  const [query, setQuery] = useState(store.state.recall?.query ?? '');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const state = store.state.recall;
  const search = (): void => {
    if (!project || !query.trim() || state?.busy) return;
    store.search(project, query.trim());
  };

  return (
    <section class="broadcast recall" aria-label="Search earlier sessions" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div class="broadcast-row">
        <span class="broadcast-label">Project</span>
        {folders.map((path) => (
          <button key={path} type="button" class={`chip${path === project ? ' on' : ''}`} title={path} onClick={() => setProject(path)}>
            {lastPart(path)}
          </button>
        ))}
      </div>
      <div class="broadcast-row">
        <span class="broadcast-label">Search</span>
        <input
          ref={field}
          class="command-input"
          type="text"
          value={query}
          maxLength={300}
          placeholder="what was asked, decided or changed: keywords"
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => event.key === 'Enter' && search()}
        />
        <button type="button" class="primary" disabled={!project || !query.trim() || state?.busy === true} onClick={search}>
          {state?.busy ? 'Searching…' : 'Search'}
        </button>
        <button type="button" class="quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {state && !state.busy && (
        <div class="recall-results">
          {state.error ? (
            <p class="broadcast-note error">{state.error}</p>
          ) : !state.matches?.length ? (
            <p class="broadcast-note">
              No results in {state.sessions ?? 0} {state.sessions === 1 ? 'earlier session' : 'earlier sessions'} of {lastPart(state.project)}.
            </p>
          ) : (
            <>
              <p class="broadcast-note">
                {state.matches.length} {state.matches.length === 1 ? 'result' : 'results'} in {state.sessions} earlier sessions of {lastPart(state.project)} · from arricurdAI, with
                secrets hidden
              </p>
              <ol class="recall-list">
                {state.matches.map((match, index) => (
                  <li key={index}>
                    <p class="recall-head">
                      <span>{when(match.at)}</span>
                      {match.request && <span class="recall-request">“{match.request}”</span>}
                    </p>
                    <pre class="recall-excerpt">{match.excerpt}</pre>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}
