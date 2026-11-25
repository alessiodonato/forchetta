import type { UpdateInfo } from '../shared/updates.ts';
import { CopyCommand, ExternalLink } from './Settings.tsx';
import type { Store } from './store.ts';

// A new version of Forchetta, under the top line: what it is, "update", and how it goes (daemon/updates.ts). The page loads
// again by itself once the new daemon answers (reload.ts).

const CHANGELOG = 'https://forchetta.dev/changelog/';

export function UpdateNotice({ info, store }: { info: UpdateInfo | undefined; store: Store }) {
  const run = info?.run;
  if (run?.state === 'running') {
    return (
      <p class="notice" role="status">
        Forchetta {run.to}: {run.text ?? 'installing'}… The sessions go on; this window loads again when it is ready.
      </p>
    );
  }
  if (run?.state === 'hooks') {
    return (
      <section class="notice update-hooks" role="alert" aria-label="The hooks of the new version">
        <p>
          Forchetta {run.to} is in place, and its hooks are other ones. This is what would change in the settings of Claude Code, with a copy of the file kept:
        </p>
        <pre>{(run.changes ?? []).join('\n')}</pre>
        <p>
          <button type="button" class="primary" onClick={() => store.updateHooks(true)}>
            Apply
          </button>{' '}
          <button type="button" class="quiet" onClick={() => store.updateHooks(false)}>
            Not now
          </button>
        </p>
      </section>
    );
  }
  if (run?.state === 'failed') {
    return (
      <p class="notice" role="alert">
        Forchetta {run.to} was not installed: {run.text}. This one goes on as it was. By hand: <CopyCommand command={info!.command} />{' '}
        {info?.latest && (
          <button type="button" class="quiet" onClick={() => store.updateForchetta()}>
            Try again
          </button>
        )}{' '}
        <button type="button" class="quiet" onClick={() => store.forgetUpdate()}>
          Close
        </button>
      </p>
    );
  }
  if (run?.state === 'done') {
    return (
      <p class="notice" role="status">
        Forchetta {run.to} is installed. <ExternalLink href={CHANGELOG}>What is new</ExternalLink>. {run.text}{' '}
        <button type="button" class="quiet" onClick={() => store.forgetUpdate()}>
          Close
        </button>
      </p>
    );
  }
  const latest = info?.latest;
  if (!latest) return null;
  return (
    <p class="notice" role="status">
      Forchetta {latest} is out. <ExternalLink href={CHANGELOG}>What is new</ExternalLink>{' '}
      <button type="button" class="primary" title="Installs it as you installed this one. The sessions go on; the plain terminals end" onClick={() => store.updateForchetta()}>
        Update
      </button>{' '}
      <button type="button" class="quiet" title="Not this version: the next one shows" onClick={() => store.hideUpdate(latest)}>
        Not this one
      </button>
    </p>
  );
}
