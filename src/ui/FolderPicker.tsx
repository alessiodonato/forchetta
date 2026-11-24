import { useEffect, useRef, useState } from 'preact/hooks';
import { useReturnFocus } from './focus.ts';
import type { Store } from './store.ts';

// The choice of a folder where there is no panel of macOS: the page in a browser, with the daemon on Linux or inside
// WSL. The daemon lists the folders (daemon/folder-list.ts); a click goes into one, the button takes the one shown.

export function FolderPicker({ store }: { store: Store }) {
  const picker = store.state.folderPicker;
  const panel = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');
  useReturnFocus(panel);
  const list = picker?.list;
  useEffect(() => {
    if (list) setTyped(list.path);
  }, [list]);
  useEffect(() => {
    panel.current?.querySelector('input')?.focus();
  }, []);
  if (!picker) return null;
  const go = (path: string): void => store.listFolders(path);
  const take = (path: string): void => store.pickFolder(path);
  return (
    <div
      class="palette-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && store.closeFolderPicker()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        store.closeFolderPicker();
      }}
    >
      <div ref={panel} class="folder-picker" role="dialog" aria-modal="true" aria-label="Choose a folder">
        <form
          class="folder-path"
          onSubmit={(event) => {
            event.preventDefault();
            go(typed);
          }}
        >
          <button type="button" class="quiet" title="The folder above" aria-label="The folder above" disabled={!list?.parent} onClick={() => list?.parent && go(list.parent)}>
            ↑
          </button>
          <input class="command-input" type="text" value={typed} aria-label="Folder" spellcheck={false} onInput={(event) => setTyped((event.target as HTMLInputElement).value)} />
          {list?.places.map((place) => (
            <button key={place.path} type="button" class="quiet" title={place.path} onClick={() => go(place.path)}>
              {place.label}
            </button>
          ))}
        </form>
        <ul class="folder-list" aria-label="Folders">
          {list?.folders.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => go(`${list.path.replace(/\/$/, '')}/${name}`)}>
                {name}
              </button>
            </li>
          ))}
          {list && list.folders.length === 0 && <li class="setup-detail">{list.error ?? 'No folders in here.'}</li>}
          {list?.more && <li class="setup-detail">…and more: write the rest of the path above.</li>}
          {!list && <li class="setup-detail">Reading…</li>}
        </ul>
        <div class="broadcast-row">
          <button type="button" class="primary" disabled={!list || Boolean(list.error)} onClick={() => list && take(list.path)}>
            Choose this folder
          </button>
          <button type="button" class="quiet" onClick={() => store.closeFolderPicker()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
