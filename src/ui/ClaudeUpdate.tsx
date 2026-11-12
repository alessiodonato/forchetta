import type { ClaudeUpdateInfo } from '../shared/agent.ts';
import type { Store } from './store.ts';

// In the top line, when the automatic update of Claude Code failed: one line for every session, since they share
// one installation, with "update" to run `claude update`. Then what it did, until you hide it.

function when(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date(now).toDateString() ? `at ${time}` : `on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

export function failedTitle(failed: NonNullable<ClaudeUpdateInfo['failed']>, now = Date.now()): string {
  const from = failed.from ? ` from ${failed.from}` : '';
  const status = failed.status ? ` (${failed.status})` : '';
  return `The automatic update of Claude Code${from} failed ${when(failed.at, now)}${status}. "update" runs claude update; the open sessions keep their version until they restart.`;
}

export function ClaudeUpdateNotice({ info, store }: { info: ClaudeUpdateInfo | undefined; store: Store }) {
  const run = info?.run;
  if (run?.state === 'running') {
    return (
      <span class="claude-update" role="status">
        <span class="claude-update-text">updating Claude Code…</span>
      </span>
    );
  }
  if (run) {
    const failed = run.state === 'error';
    const text = failed ? `claude update failed: ${run.text ?? '?'}` : (run.text ?? 'claude update done');
    return (
      <span class={`claude-update${failed ? ' failed' : ''}`} role="status">
        <span class="claude-update-text" title={text}>
          {failed && <span class="claude-update-dot" aria-hidden="true">● </span>}
          {text}
        </span>
        {failed && (
          <button type="button" class="broadcast-toggle" title="Run claude update again" onClick={() => store.updateClaude()}>
            retry
          </button>
        )}
        <button type="button" class="claude-update-close" title="Hide" aria-label="Hide" onClick={() => store.dismissClaudeUpdate()}>
          ✕
        </button>
      </span>
    );
  }
  if (!info?.failed) return null;
  return (
    <span class="claude-update failed">
      <span class="claude-update-text" title={failedTitle(info.failed)}>
        <span class="claude-update-dot" aria-hidden="true">● </span>
        Claude Code auto-update failed
      </span>
      <button type="button" class="broadcast-toggle" title="Run claude update: it installs the latest version of Claude Code, if there is one" onClick={() => store.updateClaude()}>
        update
      </button>
    </span>
  );
}
