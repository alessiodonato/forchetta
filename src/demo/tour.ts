// The tour of the demo: from the simplest thing to the most complex, one short step at a time. It reads the state
// of the page (window.forchettaDebug.store) to know when a step is done, and it can do a step for you.

import type { Agent } from '../shared/agent.ts';
import type { Store } from '../ui/store.ts';
import type { DemoDaemon } from './daemon.ts';
import { cleanName, createProject, DEMO_DIR } from './project.ts';
import { isDir } from './shims/fs.ts';

interface Step {
  title: string;
  /** Plain text with **bold** words. */
  body: string;
  /** What happened, once the step is done. */
  after?: string;
  /** Buttons that do the step, or part of it, for you. */
  actions?: Array<{ label: string; run: () => void }>;
  /** The element to point at. */
  target?: () => Element | null | undefined;
  done: () => boolean;
  enter?: () => void;
  /** Something of its own under the text: a field, a command to copy. */
  extra?: () => HTMLElement;
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const store = (): Store | undefined => window.forchettaDebug?.store as Store | undefined;
const agents = (): Agent[] => [...(store()?.state.agents.values() ?? [])].filter((agent) => agent.state !== 'ended');
const byText = (selector: string, text: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim() === text);

function bold(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

/** Sets the value of a field of the page as if typed, so that Preact sees it. */
function fill(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!element || element.value === value) return;
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

export function showNotice(notice: { title: string; body: string }): void {
  const stack = $('.demo-notices') ?? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'demo-notices' }));
  const card = document.createElement('div');
  card.className = 'demo-notice';
  card.innerHTML = `<span class="demo-notice-app">Forchetta · notification</span><strong></strong><span class="demo-notice-body"></span>`;
  card.querySelector('strong')!.textContent = notice.title;
  card.querySelector('.demo-notice-body')!.textContent = notice.body;
  stack.appendChild(card);
  setTimeout(() => card.classList.add('leaving'), 5200);
  setTimeout(() => card.remove(), 5600);
}

export function startTour(daemon: DemoDaemon): void {
  let project = 'shop';
  const folder = (): string => `${DEMO_DIR}/${project}`;
  const shown = (): string => folder().replace('/Users/you', '~');
  /** Facts seen along the way. */
  const seen = { files: false, subagents: false, freedAt: 0, waiter: '' };
  const first = (): Agent | undefined => agents().sort((a, b) => a.createdAt - b.createdAt)[0];
  const prompts = (agent: Agent | undefined): number => daemon.claudes.get(agent?.id ?? '')?.promptCount ?? 0;

  /** Types a line into the terminal of a session and presses Enter, as you would. */
  const typeInto = (agent: Agent | undefined, text: string): void => {
    const terminal = agent ? daemon.terminals.get(agent.id) : undefined;
    if (!terminal) return;
    terminal.lastInput = Date.now();
    let index = 0;
    const timer = setInterval(() => {
      if (index < text.length) terminal.onInput(text[index++]!);
      else {
        clearInterval(timer);
        terminal.onInput('\r');
      }
    }, 28);
  };

  const prefillNewSession = (prompt: string): void => {
    const panel = $('.new-session');
    if (!panel || panel.dataset.tour === prompt) return;
    panel.dataset.tour = prompt;
    fill(panel.querySelector<HTMLInputElement>('input.command-input:not(.worktree-name)'), shown());
    fill(panel.querySelector<HTMLTextAreaElement>('textarea.prompt-input'), prompt);
  };

  const steps: Step[] = [
    {
      title: 'Forchetta, in your browser',
      body: 'This is the real Forchetta app, running in this page. Only the Claude Code sessions are pretend: their answers are a script, so nothing here costs tokens or touches your computer.\n\nThe tour goes from the simplest thing to the most complex, in 9 short steps.',
      done: () => true,
    },
    {
      title: 'Make a project',
      body: 'First, a folder to work in. The demo makes a small web shop for you: a few files in a git repository, kept in this page.',
      extra: () => {
        const box = document.createElement('div');
        box.className = 'tour-field';
        box.innerHTML = `<label>~/demo/<input type="text" value="${project}" spellcheck="false" aria-label="Project name"></label><button type="button" class="tour-primary">Create the project</button>`;
        const input = box.querySelector('input')!;
        const button = box.querySelector('button')!;
        const make = (): void => {
          project = cleanName(input.value);
          input.value = project;
          createProject(project);
          render();
        };
        button.addEventListener('click', make);
        input.addEventListener('keydown', (event) => event.key === 'Enter' && make());
        return box;
      },
      done: () => isDir(folder()),
      after: 'Done: ~/demo/shop has package.json, src/api.ts, src/orders.ts and a few tests.',
    },
    {
      title: 'Start a session',
      body: 'Click **new session**, at the top right. The folder and a first message are filled in for you: press **start**.\n\nForchetta starts `claude` in a terminal of its own, so later it can type into it for you.',
      target: () => ($('.new-session') ? $('.new-session button.primary') : $('header.top .broadcast-toggle.primary')),
      enter: () => undefined,
      done: () => agents().length > 0,
      after: 'The session started. On the left, its **box**; on the right, its **terminal**.',
    },
    {
      title: 'Read the box',
      body: 'Watch the session write its test. The box tells you what Claude is doing right now, then what it did. The thin bar is how full its context is; next to it, what the session costs.\n\nYou never need the terminal to know where a session stands.',
      target: () => $('.box'),
      done: () => (first()?.completedAt ?? 0) > 0,
      after: 'The turn is over: the box shows a check, and the summary of what it did.',
    },
    {
      title: 'Type in the terminal',
      body: 'The terminal is a real one. Click in it, type **update the readme** and press Enter.',
      actions: [{ label: 'Type it for me', run: () => typeInto(first(), 'update the readme') }],
      target: () => $('.pane .terminal, .pane'),
      done: () => prompts(first()) >= 2,
      after: 'What you type goes straight to the session, as in any terminal.',
    },
    {
      title: 'Answer a permission',
      body: 'Some commands need your OK. Ask the session to **build the project**: it wants to delete the old build first, so Claude Code asks for permission.\n\nThe box asks too. Answer from there, with **Allow**: no need to find the right terminal.',
      actions: [{ label: 'Ask it for me', run: () => typeInto(first(), 'build the project') }],
      target: () => $('button.allow') ?? $('.box'),
      done: () => daemon.permissionsAnswered > 0,
      after: 'Answered. The terminal showed the same question: whichever you answer first wins.',
    },
    {
      title: 'Commands from the box',
      body: 'Hover the box: it has commands of its own. **btw…** asks a side question while the session keeps working; **compact** shrinks its context. Try both.\n\nForchetta types a command only when it is safe: never into a dialog, never over something you are typing.',
      target: () => $('.box'),
      done: () => {
        const done = (kind: string): boolean => agents().some((agent) => (agent.commands ?? []).some((command) => command.kind === kind && command.status === 'confermato'));
        return done('btw') && done('compact');
      },
      after: 'Both went through. The context bar dropped after compact.',
    },
    {
      title: 'Two sessions, one file',
      body: 'Now the guard. We named this session **retries** (✎ in a box does it). Ask it to **add retries to src/api.ts**: its tests are slow, so it keeps the file for a while.\n\nWhile it works, start a **second session** in the same folder and ask it to **add a rate limit to src/api.ts**. Watch both boxes.\n\nIf retries finishes first, ask it again: the guard only holds a file during a turn.',
      actions: [
        { label: '1. Ask for the retries', run: () => typeInto(first(), 'add retries to src/api.ts') },
        {
          label: '2. Start the second session',
          run: () =>
            void daemon.spawn({ cwd: folder(), prompt: 'add a rate limit to src/api.ts' }, { team: { label: 'rate-limit' } }).then((result) => {
              // Its terminal opens next to the first one, as for a session started from the panel.
              if (result.ok) setTimeout(() => store()?.open(result.agentId), 400);
            }),
        },
      ],
      target: () => ($('.new-session') ? $('.new-session button.primary') : $('header.top .broadcast-toggle.primary')),
      enter: () => {
        // Two sessions in one folder have the same name: the tour names them, as ✎ in a box does.
        const one = first();
        if (one && !one.team?.label) daemon.label(one.id, 'retries');
        seen.freedAt = 0;
        daemon.onFreed = (waiter) => {
          seen.freedAt = Date.now();
          seen.waiter = waiter;
        };
      },
      done: () => seen.freedAt > 0 && (store()?.state.agents.get(seen.waiter)?.completedAt ?? 0) > seen.freedAt,
      after: 'The second session was stopped before it touched src/api.ts, and Claude was told why. When the first one ended its turn, Forchetta told the second that the file was free, and it went on by itself.',
    },
    {
      title: 'What each session did',
      body: 'Each box counts the files its session changed. Click **files** in a box: you get every edit, one by one, and the diff since the last commit.\n\nThen ask a session to **find where orders are read**. Claude hands the search to a subagent, and the box lists it: click it to follow its work.',
      actions: [{ label: 'Ask for the search', run: () => typeInto(first(), 'find where orders are read') }],
      target: () => byText('.box button, .box .link', 'files') ?? [...document.querySelectorAll<HTMLElement>('.box button')].find((button) => /\bfiles?\b/.test(button.textContent ?? '')) ?? $('.box'),
      done: () => seen.files && seen.subagents,
      after: 'Forchetta keeps what each session changed and what its subagents did, so you can check it without asking.',
    },
    {
      title: 'A team of agents',
      body: 'Last, a team: a lead and its members, each a Claude Code session. Click **new team**, keep **developer + reviewer** and the folder, and start it.\n\nThen click **team** and write a goal to the lead, like **add a countOrders function**. The lead hands out the work and collects the answers.',
      target: () => byText('header.top .broadcast-toggle', (store()?.state.crews.length ?? 0) > 0 ? 'team' : 'new team'),
      done: () => {
        const crew = store()?.state.crews[0];
        if (!crew || (crew.requests?.length ?? 0) < 2) return false;
        const lead = crew.recipients?.find((recipient) => recipient.lead)?.agentId;
        const leadAgent = lead ? store()?.state.agents.get(lead) : undefined;
        return leadAgent?.state === 'idle' && (crew.requests ?? []).every((request) => request.deliveries.every((delivery) => delivery.status === 'done' || delivery.status === 'failed' || delivery.status === 'cancelled'));
      },
      after: 'The lead gave the work to developer, then had reviewer check it, and reported back. Every request is in the thread of the team.',
    },
    {
      title: 'That is Forchetta',
      body: 'On your Mac it shows every Claude Code session you run, in any terminal, and keeps them off each other’s files. Free and open source, macOS 12 or later.',
      extra: () => {
        const box = document.createElement('div');
        box.className = 'tour-end';
        box.innerHTML = `<button type="button" class="tour-copy" data-copy="brew install alessiodonato/tap/forchetta"><code>brew install alessiodonato/tap/forchetta</code><span>Copy</span></button><p><a href="../#install">Install</a> · <a href="../manual.html">Manual</a> · <a href="https://github.com/alessiodonato/forchetta">GitHub</a></p>`;
        const button = box.querySelector<HTMLButtonElement>('.tour-copy')!;
        button.addEventListener('click', () => {
          void navigator.clipboard?.writeText(button.dataset.copy ?? '').then(() => {
            button.querySelector('span')!.textContent = 'Copied';
          });
        });
        return box;
      },
      done: () => true,
    },
  ];

  // ---- The panel -----------------------------------------------------------------------------------------

  const panel = $('.tour')!;
  let index = 0;
  let wasDone = false;
  let target: Element | undefined;

  function render(): void {
    const step = steps[index]!;
    const isDone = step.done();
    wasDone = isDone;
    panel.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tour-head';
    const counted = steps.length - 2;
    head.innerHTML = `<a class="tour-home" href="../">Forchetta</a><span class="tour-count">${index === 0 ? `${counted} steps` : index > counted ? 'done' : `step ${index} of ${counted}`}</span>`;
    const progress = document.createElement('div');
    progress.className = 'tour-progress';
    progress.innerHTML = steps
      .slice(1, -1)
      .map((_, at) => `<i class="${at + 1 < index ? 'past' : at + 1 === index ? 'now' : ''}"></i>`)
      .join('');
    const title = document.createElement('h2');
    title.textContent = step.title;
    const body = document.createElement('div');
    body.className = 'tour-body';
    body.innerHTML = step.body
      .split('\n\n')
      .map((paragraph) => `<p>${bold(paragraph)}</p>`)
      .join('');
    panel.append(head, progress, title, body);
    if (step.extra) panel.append(step.extra());
    if (step.actions && !isDone) {
      const actions = document.createElement('div');
      actions.className = 'tour-actions';
      for (const action of step.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tour-secondary';
        button.textContent = action.label;
        button.addEventListener('click', () => {
          action.run();
          button.disabled = true;
        });
        actions.append(button);
      }
      panel.append(actions);
    }
    if (isDone && step.after) {
      const after = document.createElement('p');
      after.className = 'tour-after';
      after.innerHTML = `<span aria-hidden="true">✓</span> ${bold(step.after.replace('~/demo/shop', shown()))}`;
      panel.append(after);
    }
    const nav = document.createElement('div');
    nav.className = 'tour-nav';
    if (index > 0) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'tour-quiet';
      back.textContent = 'Back';
      back.addEventListener('click', () => go(index - 1));
      nav.append(back);
    }
    if (index < steps.length - 1) {
      const next = document.createElement('button');
      next.type = 'button';
      next.className = isDone ? 'tour-primary' : 'tour-quiet';
      next.textContent = index === 0 ? 'Start' : isDone ? 'Next' : 'Skip';
      next.addEventListener('click', () => go(index + 1));
      nav.append(next);
    }
    panel.append(nav);
  }

  function go(next: number): void {
    index = Math.max(0, Math.min(steps.length - 1, next));
    steps[index]!.enter?.();
    render();
    panel.scrollTop = 0;
  }

  // Every half second: what the page shows now, the element to point at, and whether the step got done.
  setInterval(() => {
    const state = store()?.state;
    if (state?.files) seen.files = true;
    if (state?.subagents) seen.subagents = true;
    const step = steps[index]!;
    if (step.title === 'Start a session' || step.title === 'Two sessions, one file') prefillNewSession(step.title === 'Start a session' ? 'write a test for the order total' : 'add a rate limit to src/api.ts');
    const point = isDone() ? undefined : (step.target?.() ?? undefined);
    if (point !== target) {
      target?.classList.remove('tour-target');
      point?.classList.add('tour-target');
      target = point ?? undefined;
    }
    if (step.done() !== wasDone) render();
  }, 500);

  function isDone(): boolean {
    return steps[index]!.done();
  }

  render();
}
