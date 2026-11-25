import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditableSettings, OptionalFeature, SetupCheck, SystemInfo } from '../shared/system.ts';
import { openLink } from './Artifacts.tsx';
import { askNotifications, notificationState } from './browser-shell.ts';
import { shell } from './connection.ts';
import { useReturnFocus } from './focus.ts';
import { IS_MAC } from './platform.ts';
import { FONT_MAX, FONT_MIN, messageMarks, onTerminalFontSize, setMessageMarks, setTerminalFontSize, terminalFontSize } from './prefs.ts';
import type { Store } from './store.ts';
import { applyTheme, currentTheme, type Theme } from './theme.ts';

// The settings of Forchetta (⌘,), in place of var/config.json by hand: the guard, the times of the sessions, the
// shortcut and the port, which the daemon saves; the look of this window, kept here. Above them, what is not in place
// yet, with the command that fixes it; below, the optional features and why they are off.

export const MANUAL = 'https://forchetta.dev/manual.html';

/** A link that opens in the default browser (the window of the app does not leave the page). */
export function ExternalLink({ href, children, class: className }: { href: string; children: preact.ComponentChildren; class?: string }) {
  return (
    <a
      class={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        openLink(href);
      }}
    >
      {children}
    </a>
  );
}

/** A command to copy into a terminal, with its button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span class="copy-command">
      <code>{command}</code>
      <button
        type="button"
        class="quiet"
        aria-label={`Copy ${command}`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

/** The checks that are not in place, each with what to do. Nothing when all are. */
export function SetupChecks({ system, store, all = false }: { system: SystemInfo; store: Store; all?: boolean }) {
  const shown = all ? system.checks : system.checks.filter((check) => !check.ok);
  if (shown.length === 0) return null;
  return (
    <ul class="setup-checks">
      {shown.map((check: SetupCheck) => (
        <li key={check.id} class={check.ok ? 'ok' : 'missing'}>
          <span class="setup-mark" aria-hidden="true">
            {check.ok ? '✓' : '✗'}
          </span>
          <span class="setup-text">
            <strong>{check.label}</strong>
            {check.detail ? <span class="setup-detail"> — {check.detail}</span> : null}
            {check.fix ? (
              <span class="setup-fix">
                <CopyCommand command={check.fix} />
              </span>
            ) : null}
          </span>
          <span class="sr-only">{check.ok ? 'in place' : 'missing'}</span>
        </li>
      ))}
      {!all && (
        <li class="setup-again">
          <button type="button" class="quiet" onClick={() => store.refreshSystem()}>
            Check again
          </button>
        </li>
      )}
    </ul>
  );
}

function Feature({ feature }: { feature: OptionalFeature }) {
  return (
    <li class={feature.on ? 'on' : 'off'}>
      <span class={`feature-state ${feature.on ? 'on' : 'off'}`}>{feature.on ? 'on' : 'off'}</span>
      <span>
        <strong>{feature.label}</strong> <span class="setup-detail">— {feature.why}</span>
        {!feature.on && feature.how ? (
          <span class="setup-fix">{feature.how.startsWith('forchetta ') ? <CopyCommand command={feature.how} /> : feature.how}</span>
        ) : null}
        {feature.link ? (
          <ExternalLink class="feature-link" href={feature.link}>
            more
          </ExternalLink>
        ) : null}
      </span>
    </li>
  );
}

const THEMES: { theme: Theme; label: string }[] = [
  { theme: 'dark', label: 'dark' },
  { theme: 'light', label: 'light' },
  { theme: 'system', label: 'as the system' },
];

export function SettingsPanel({ store, onClose }: { store: Store; onClose: () => void }) {
  const system = store.state.system;
  const panel = useRef<HTMLElement>(null);
  useReturnFocus(panel);
  const [draft, setDraft] = useState<EditableSettings | undefined>(system?.settings);
  // The settings come with the first hello: the form takes them once they are there.
  useEffect(() => {
    if (!draft && system) setDraft(system.settings);
  }, [system]);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [font, setFont] = useState(terminalFontSize);
  const [notifications, setNotifications] = useState(notificationState);
  const [marked, setMarked] = useState(messageMarks);
  useEffect(() => onTerminalFontSize(setFont), []);
  const saving = store.state.settingsSave;
  const opened = useRef(Date.now());
  const result = saving && saving.at >= opened.current && !saving.busy ? saving : undefined;
  const changed = Boolean(draft && system && JSON.stringify(draft) !== JSON.stringify(system.settings));

  const set = (patch: Partial<EditableSettings>): void => setDraft((current) => (current ? { ...current, ...patch } : current));
  const guard = (key: keyof EditableSettings['guard'], label: string, help: string) =>
    draft && (
      <label class="setting-check">
        <input type="checkbox" checked={draft.guard[key]} onChange={(event) => set({ guard: { ...draft.guard, [key]: (event.target as HTMLInputElement).checked } })} />
        <span>
          {label} <span class="setup-detail">— {help}</span>
        </span>
      </label>
    );

  return (
    <section ref={panel} class="broadcast settings-panel" aria-label="Settings" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      {!system ? (
        <p class="broadcast-note">This daemon is older than the page: restart it to change the settings here (forchetta daemon stop, then {IS_MAC ? 'open the app' : 'forchetta open'}).</p>
      ) : (
        <>
          {system.checks.some((check) => !check.ok) && (
            <div class="settings-group">
              <h2>Not in place yet</h2>
              <SetupChecks system={system} store={store} />
            </div>
          )}
          {draft && (
            <form
              class="settings-group"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft) store.saveSettings(draft);
              }}
            >
              <h2>The guard</h2>
              {guard('files', 'Files', 'stops an edit of a file another session is changing in its turn')}
              {guard('git', 'git', 'asks before a git command that would change the files under another session')}
              {guard('notes', 'Notes', 'tells Claude which files it read were changed by another session, and who works where')}
              {guard('servers', 'Servers', 'points to the dev server already running; asks before a kill of another session’s process')}
              <p class="setup-detail">A repository can turn parts on or off for itself in .forchetta/guard.json.</p>

              <h2>Sessions</h2>
              <label class="setting-row" for="setting-stall">
                <span>A session at work seems stuck after</span>
                <input id="setting-stall" type="number" min={1} max={240} value={draft.stallMin} onInput={(event) => set({ stallMin: Number((event.target as HTMLInputElement).value) })} />
                <span>minutes with no event</span>
              </label>
              <label class="setting-row" for="setting-ended">
                <span>A finished session stays in the list for</span>
                <input id="setting-ended" type="number" min={1} max={1440} value={draft.endedRetentionMin} onInput={(event) => set({ endedRetentionMin: Number((event.target as HTMLInputElement).value) })} />
                <span>minutes</span>
              </label>
              {store.state.restarts && <label class="setting-check">
                <input type="checkbox" checked={draft.autoRestart === true} onChange={(event) => set({ autoRestart: (event.target as HTMLInputElement).checked })} />
                <span>
                  Sessions restart by themselves on a new Claude Code <span class="setup-detail">— with /restart, which keeps the conversation: only at rest, one at a time, once their prompt cache is over</span>
                </span>
              </label>}
              <div class="setting-row" role="group" aria-label="A fifth pane">
                <span>A fifth pane</span>
                <button type="button" class={`chip${draft.replace === 'lru' ? ' on' : ''}`} aria-pressed={draft.replace === 'lru'} onClick={() => set({ replace: 'lru' })}>
                  replaces the one used least
                </button>
                <button type="button" class={`chip${draft.replace === 'chiedi' ? ' on' : ''}`} aria-pressed={draft.replace === 'chiedi'} onClick={() => set({ replace: 'chiedi' })}>
                  asks which one
                </button>
              </div>

              <h2>{(system.platform ?? 'macos') === 'macos' ? 'The app' : 'The daemon'}</h2>
              {(system.platform ?? 'macos') === 'macos' && <label class="setting-row" for="setting-hotkey">
                <span>Show or hide Forchetta from anywhere with</span>
                <input id="setting-hotkey" type="text" value={draft.hotkey} placeholder="ctrl+alt+f" onInput={(event) => set({ hotkey: (event.target as HTMLInputElement).value })} />
                <span class="setup-detail">empty for none</span>
              </label>}
              <label class="setting-row" for="setting-port">
                <span>Port of the daemon on 127.0.0.1</span>
                <input id="setting-port" type="number" min={1024} max={65535} value={draft.port} onInput={(event) => set({ port: Number((event.target as HTMLInputElement).value) })} />
                <span class="setup-detail">after a restart</span>
              </label>
              <label class="setting-check">
                <input type="checkbox" checked={draft.haiku} onChange={(event) => set({ haiku: (event.target as HTMLInputElement).checked })} />
                <span>
                  One-line summaries by Haiku <span class="setup-detail">— calls the Anthropic API with FORCHETTA_ANTHROPIC_API_KEY; after a restart</span>
                </span>
              </label>
              <div class="broadcast-row">
                <button type="submit" class="primary" disabled={!changed || saving?.busy}>
                  {saving?.busy ? 'Saving…' : 'Save'}
                </button>
                {changed && (
                  <button type="button" class="quiet" onClick={() => setDraft(system.settings)}>
                    Undo the changes
                  </button>
                )}
                <span class="broadcast-note" role="status">
                  {result?.error ? <span class="error-text">{result.error}</span> : result?.ok ? (result.restart?.length ? `Saved. ${result.restart.join(' and ')}: after a restart of the daemon.` : 'Saved.') : null}
                </span>
              </div>
            </form>
          )}
        </>
      )}

      <div class="settings-group">
        <h2>This window</h2>
        <div class="setting-row" role="group" aria-label="Theme">
          <span>Theme</span>
          {THEMES.map((option) => (
            <button
              key={option.theme}
              type="button"
              class={`chip${theme === option.theme ? ' on' : ''}`}
              aria-pressed={theme === option.theme}
              onClick={() => {
                applyTheme(option.theme);
                setTheme(option.theme);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {!IS_MAC && !shell() && notifications !== 'unsupported' && (
          <div class="setting-row">
            <span>Notifications when a session waits for you</span>
            {notifications === 'default' ? (
              <button type="button" class="chip" onClick={() => void askNotifications().then(setNotifications)}>
                allow them
              </button>
            ) : (
              <span class="setup-detail">{notifications === 'granted' ? 'on, while this page is open' : 'blocked: allow them for this page in the settings of the browser'}</span>
            )}
          </div>
        )}
        <label class="setting-row" for="setting-font">
          <span>Text of the terminals</span>
          <input id="setting-font" type="range" min={FONT_MIN} max={FONT_MAX} value={font} onInput={(event) => setTerminalFontSize(Number((event.target as HTMLInputElement).value))} />
          <span>{font} px</span>
        </label>
        <label class="setting-check">
          <input type="checkbox" checked={marked} onChange={(event) => {
            const on = (event.target as HTMLInputElement).checked;
            setMarked(on);
            setMessageMarks(on);
          }} />
          <span>
            Mark my messages in the terminals <span class="setup-detail">— a bar on their left, to tell them from the answers of Claude</span>
          </span>
        </label>
        <p class="setup-detail">{IS_MAC ? 'The whole page: View → Zoom In / Zoom Out in the app (⌘+ ⌘− ⌘0).' : 'The whole page: the zoom of the browser (Ctrl++ Ctrl+− Ctrl+0).'}</p>
      </div>

      {system && (
        <div class="settings-group">
          <h2>Optional features</h2>
          <ul class="features">
            {system.features.map((feature) => (
              <Feature key={feature.id} feature={feature} />
            ))}
          </ul>
          <h2>About</h2>
          <p class="setup-detail">
            Forchetta {system.version} · Claude Code {system.claude.installed ?? '?'} (tested with {system.claude.tested}) · data in {system.varDir} · log in {system.logFile}
          </p>
          <p class="setup-detail">
            Something wrong? <CopyCommand command="forchetta doctor" /> says what, and <code>--bundle</code> writes a file for an issue.{' '}
            <ExternalLink href={MANUAL}>The manual</ExternalLink>
          </p>
        </div>
      )}
      <div class="broadcast-row">
        <button type="button" class="quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
