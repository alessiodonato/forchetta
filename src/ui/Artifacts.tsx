import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent } from '../shared/agent.ts';
import { type ArtifactLink, openableUrl } from '../shared/artifacts.ts';
import { agoShort } from '../shared/present.ts';
import { shell } from './connection.ts';

// The artifacts of claude.ai a session published or opened (shared/artifacts.ts), in its box and in the header of
// its pane: one opens with a click, several in a short list. They open in the default browser, where you are
// signed in to claude.ai: the app asks macOS to open the link, and checks it first. The list is drawn over the page,
// at the button: a box hides what goes past its edges, and the bar of its commands covers its last line on hover.

/** Opens a link in the default browser: through the app, or a new tab when the page runs in a browser. */
export function openLink(url: string): void {
  if (!openableUrl(url)) return;
  const app = shell();
  if (app) app.postMessage({ type: 'openUrl', url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** "1 artifact", "3 artifacts". */
export const artifactsLabel = (count: number): string => `${count} ${count === 1 ? 'artifact' : 'artifacts'}`;

/** What a line of the list says of an artifact: its title, or its link when it has none. */
export const artifactName = (artifact: ArtifactLink): string => artifact.title ?? artifact.url.replace(/^https:\/\//, '');

/** Where the list goes: over or under the button, where there is more room, and on its side of the window. */
export function menuPlace(button: { top: number; bottom: number; left: number; right: number }, view: { width: number; height: number }): { top?: number; bottom?: number; left?: number; right?: number } {
  const vertical = button.top > view.height - button.bottom ? { bottom: view.height - button.top + 6 } : { top: button.bottom + 6 };
  const horizontal = (button.left + button.right) / 2 < view.width / 2 ? { left: Math.max(8, button.left) } : { right: Math.max(8, view.width - button.right) };
  return { ...vertical, ...horizontal };
}

export function ArtifactsButton({ agent, className }: { agent: Agent; className?: string }) {
  const [place, setPlace] = useState<ReturnType<typeof menuPlace>>();
  const [copied, setCopied] = useState<string>();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const list = agent.artifacts ?? [];
  const open = place !== undefined;

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(undefined);
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  if (list.length === 0) return null;
  const only = list.length === 1 ? list[0] : undefined;
  const now = Date.now();

  return (
    <span class="artifacts">
      <button
        ref={button}
        type="button"
        class={className ?? 'files-button'}
        title={only ? `Open "${artifactName(only)}" in the browser` : 'The artifacts of claude.ai this session published or opened'}
        aria-expanded={only ? undefined : open}
        onClick={(event) => {
          event.stopPropagation();
          if (only) openLink(only.url);
          else if (open) setPlace(undefined);
          else if (button.current) setPlace(menuPlace(button.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
        }}
      >
        {artifactsLabel(list.length)}
      </button>
      {open && !only && createPortal(
        <div class="artifacts-menu" ref={menu} role="menu" style={place} onClick={(event) => event.stopPropagation()}>
          {list.map((artifact) => (
            <div class="artifacts-item" key={artifact.url}>
              <button
                type="button"
                role="menuitem"
                class="artifacts-open"
                title={artifact.url}
                onClick={() => {
                  openLink(artifact.url);
                  setPlace(undefined);
                }}
              >
                <span class="artifacts-title">{artifactName(artifact)}</span>
                <span class="artifacts-when">
                  {artifact.opened ? 'opened' : 'published'} · {agoShort(now - artifact.at)}
                </span>
              </button>
              <button
                type="button"
                class="artifacts-copy"
                title="Copy the link"
                onClick={() => {
                  void navigator.clipboard?.writeText(artifact.url).then(
                    () => setCopied(artifact.url),
                    () => setCopied(undefined),
                  );
                }}
              >
                {copied === artifact.url ? 'copied' : 'copy'}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
