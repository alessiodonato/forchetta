import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { shell } from './connection.ts';
import type { Store } from './store.ts';

// A new session from the app: a folder and, if you want, a first prompt, a model, a permission mode and a new git
// worktree. The daemon starts it in the tmux of Forchetta, through your login shell (daemon/spawn.ts), and the page
// opens its terminal: a folder never seen before first asks there whether you trust it. Model, mode and worktree
// are options of claude for that session only.

declare global {
  interface Window {
    /** From the app: the folder chosen in the panel of macOS. */
    forchettaFolder?: (path: string) => void;
  }
}

/** The folders of the sessions known, the most recent first. */
export function recentFolders(agents: readonly Agent[], max = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const agent of [...agents].sort((a, b) => b.lastEvent.at - a.lastEvent.at)) {
    if (!agent.cwd || seen.has(agent.cwd)) continue;
    seen.add(agent.cwd);
    out.push(agent.cwd);
    if (out.length === max) break;
  }
  return out;
}

const lastPart = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

const MODELS = [
  ['', 'predefinito'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
] as const;

const MODES = [
  ['', 'predefiniti'],
  ['manual', 'chiede ogni volta'],
  ['acceptEdits', 'accetta modifiche'],
  ['auto', 'auto'],
  ['plan', 'piano'],
] as const;

export function NewSessionPanel({ agents, store, onClose }: { agents: readonly Agent[]; store: Store; onClose: () => void }) {
  const recent = useMemo(() => recentFolders(agents), [agents]);
  const [folder, setFolder] = useState(recent[0] ?? '');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [worktreeName, setWorktreeName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const state = store.state.spawn;
  const busy = state?.busy === true;

  useEffect(() => {
    field.current?.focus();
    window.forchettaFolder = (path: string) => setFolder(path);
    return () => {
      window.forchettaFolder = undefined;
    };
  }, []);

  const start = (): void => {
    if (busy || !folder.trim()) return;
    store.spawn(folder, prompt, { model, mode, worktree: worktree ? worktreeName.trim() || true : undefined });
  };

  return (
    <section class="broadcast new-session" aria-label="Nuova sessione" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div class="broadcast-row">
        <span class="broadcast-label">Cartella</span>
        <input
          ref={field}
          class="command-input mono"
          type="text"
          value={folder}
          placeholder="~/progetti/app"
          spellcheck={false}
          onInput={(event) => setFolder((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => event.key === 'Enter' && start()}
        />
        {shell() && (
          <button type="button" onClick={() => shell()?.postMessage({ type: 'chooseFolder', folder })}>
            Scegli…
          </button>
        )}
      </div>
      {recent.length > 0 && (
        <div class="broadcast-row">
          <span class="broadcast-label" />
          {recent.map((path) => (
            <button key={path} type="button" class={`chip${path === folder ? ' on' : ''}`} title={path} onClick={() => setFolder(path)}>
              {lastPart(path)}
            </button>
          ))}
        </div>
      )}
      <div class="broadcast-row">
        <span class="broadcast-label">Opzioni</span>
        <label class="spawn-option">
          modello
          <select value={model} onChange={(event) => setModel((event.target as HTMLSelectElement).value)}>
            {MODELS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label class="spawn-option">
          permessi
          <select value={mode} onChange={(event) => setMode((event.target as HTMLSelectElement).value)}>
            {MODES.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label class="spawn-option" title="Claude Code crea un worktree git nuovo per la sessione: lavora su una copia, senza toccare i file delle altre">
          <input type="checkbox" checked={worktree} onChange={() => setWorktree(!worktree)} />
          worktree nuovo
        </label>
        {worktree && (
          <input
            class="command-input mono worktree-name"
            type="text"
            value={worktreeName}
            maxLength={40}
            placeholder="nome (facoltativo)"
            spellcheck={false}
            onInput={(event) => setWorktreeName((event.target as HTMLInputElement).value)}
          />
        )}
      </div>
      <div class="broadcast-row top">
        <span class="broadcast-label">Prompt</span>
        <textarea
          class="command-input prompt-input"
          rows={4}
          value={prompt}
          maxLength={20_000}
          placeholder="Il primo messaggio per Claude (facoltativo). ⌘↩ avvia."
          onInput={(event) => setPrompt((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) start();
          }}
        />
      </div>
      <div class="broadcast-row end">
        <span class={`broadcast-note${state?.error ? ' error' : ''}`}>
          {state?.error ?? 'Parte nel tmux di Forchetta, con l’ambiente della tua shell, e si apre qui.'}
        </span>
        <button type="button" class="primary" disabled={busy || !folder.trim()} onClick={start}>
          {busy ? 'Avvio…' : 'Avvia'}
        </button>
        <button type="button" class="quiet" onClick={onClose}>
          Annulla
        </button>
      </div>
    </section>
  );
}
