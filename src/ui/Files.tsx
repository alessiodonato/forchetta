import { useEffect, useMemo, useState } from 'preact/hooks';
import { type Agent, displayName, type FileChange, type SessionEdit } from '../shared/agent.ts';
import { agoShort } from '../shared/present.ts';
import type { Store } from './store.ts';

// The changes of a session: the files it wrote, and for each two views. "Di questa sessione": what the session
// itself changed, change by change, as Claude Code reported it. "Dall'ultimo commit": what git says changed, others'
// changes to the same file included. Read when the panel opens, and again with "aggiorna". The diff has no green
// and red: in Forchetta they mean a state.

/** "3 file" in the box and in the header of a pane: opens the panel. */
export function FilesButton({ agent, store, className }: { agent: Agent; store: Store; className?: string }) {
  const count = agent.filesChanged ?? 0;
  if (count === 0) return null;
  return (
    <button
      type="button"
      class={className ?? 'files-button'}
      title="The files this session changed, with the diff since the last commit"
      onClick={(event) => {
        event.stopPropagation();
        store.showFiles(agent.id);
      }}
    >
      {count} {count === 1 ? 'file' : 'files'}
    </button>
  );
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'same';

function lineKind(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'same';
}

/** Lines added and removed by the changes of the session. */
export function countEdits(edits: readonly SessionEdit[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    for (const hunk of edit.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
  }
  return { added, removed };
}

const EDIT_NAME: Record<string, string> = { Edit: 'edit', MultiEdit: 'edits', Write: 'rewrite' };

/** The changes of the session to a file, one after the other, each with its blocks. */
function SessionEdits({ edits, now }: { edits: readonly SessionEdit[]; now: number }) {
  return (
    <div class="edits">
      {edits.map((edit, index) => (
        <section key={index} class="edit">
          <p class="edit-head">
            {edit.created ? 'file created' : (EDIT_NAME[edit.tool] ?? edit.tool)} · {agoShort(now - edit.at)} ago
            {edit.truncated ? ' · truncated' : ''}
          </p>
          <pre class="diff">
            {edit.hunks.map((hunk, hunkIndex) => (
              <span key={hunkIndex}>
                {!edit.created && <span class="diff-line hunk">{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`}</span>}
                {hunk.lines.map((line, lineIndex) => (
                  <span key={lineIndex} class={`diff-line ${line.startsWith('\\') ? 'meta' : lineKind(line)}`}>
                    {line || ' '}
                    {'\n'}
                  </span>
                ))}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function Diff({ file }: { file: FileChange }) {
  const lines = useMemo(() => (file.diff ?? '').replace(/\n$/, '').split('\n'), [file.diff]);
  if (!file.diff) return <p class="files-note">{file.note ?? 'no diff'}</p>;
  return (
    <pre class="diff">
      {lines.map((line, index) => (
        <span key={index} class={`diff-line ${lineKind(line)}`}>
          {line || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** The end of a long path, from a whole folder: "…/var/e2e/alpha/nuovo2.txt". The full path is in the title. */
export function tailOf(path: string, max = 34): string {
  if (path.length <= max) return path;
  const parts = path.split('/');
  let tail = parts.pop() ?? path;
  while (parts.length > 0 && tail.length + parts[parts.length - 1]!.length + 1 <= max - 2) tail = `${parts.pop()}/${tail}`;
  return `…/${tail}`;
}

function countText(file: FileChange, view: 'session' | 'git'): string {
  if (view === 'git') return file.diff ? `+${file.added} −${file.removed}` : '—';
  if (!file.edits?.length) return '—';
  const { added, removed } = countEdits(file.edits);
  return `+${added} −${removed}`;
}

export function FilesPanel({ store, now }: { store: Store; now: number }) {
  const files = store.state.files;
  const agent = files ? store.state.agents.get(files.agentId) : undefined;
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<'session' | 'git'>('session');
  useEffect(() => setSelected(0), [files?.agentId]);
  useEffect(() => {
    if (!files) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.closeFiles();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files !== undefined]);
  if (!files) return null;
  const list = files.list ?? [];
  const current = list[Math.min(selected, list.length - 1)];
  return (
    <div class="files-backdrop" onClick={() => store.closeFiles()}>
      <section class="files" aria-label="Changes of the session" onClick={(event) => event.stopPropagation()}>
        <header class="files-head">
          <span class="files-title">
            Changes by <strong>{agent ? displayName(agent) : '?'}</strong>
          </span>
          <span class="view-switch" role="group" aria-label="View">
            <button type="button" class={view === 'session' ? 'on' : undefined} onClick={() => setView('session')}>
              by this session
            </button>
            <button type="button" class={view === 'git' ? 'on' : undefined} onClick={() => setView('git')}>
              since the last commit
            </button>
          </span>
          <span class="files-sub">only the files written with Edit and Write</span>
          <button type="button" class="quiet" onClick={() => store.showFiles(files.agentId)} disabled={files.list === undefined}>
            refresh
          </button>
          <button type="button" class="files-close" title="Close (Esc)" onClick={() => store.closeFiles()}>
            ✕
          </button>
        </header>
        {files.list === undefined ? (
          <p class="files-note">Reading the changes…</p>
        ) : list.length === 0 ? (
          <p class="files-note">No file written by this session.</p>
        ) : (
          <div class="files-body">
            <ul class="files-list">
              {list.map((file, index) => (
                <li key={file.path}>
                  <button type="button" class={index === selected ? 'on' : undefined} title={file.path} onClick={() => setSelected(index)}>
                    <span class="files-name">{tailOf(file.name)}</span>
                    <span class="files-count">{countText(file, view)}</span>
                    <span class="files-when">{agoShort(now - file.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div class="files-diff">
              {current &&
                (view === 'git' ? (
                  <Diff file={current} />
                ) : current.edits && current.edits.length > 0 ? (
                  <SessionEdits edits={current.edits} now={now} />
                ) : (
                  <p class="files-note">No change by this session is recorded for this file (those made before Forchetta recorded them are missing): see “since the last commit”.</p>
                ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
