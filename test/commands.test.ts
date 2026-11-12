import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Commander, type ResetNotes } from '../src/daemon/commands.ts';
import { Registry } from '../src/daemon/registry.ts';
import type { HookPayload } from '../src/daemon/state.ts';
import type { TmuxCommand, TmuxResult } from '../src/shared/tmux.ts';
import { sleep } from './helpers.ts';

const RULE = '─'.repeat(60);
const box = (typed: string): string => ['⏺ fatto', RULE, `❯ ${typed}`, RULE, '  footer'].join('\n');
const BTW_OPEN = (question: string): string => [`❯ ${question}`, `  ${question}`, '    risposta', '  Esc to close'].join('\n');

/** A tmux with one session per agent: what is on screen, who runs in the pane, when someone last typed. */
class FakeTmux {
  readonly panes = new Map<string, { session: string; pid: number; screen: string; activity: number; afterEnter?: (typed: string) => string; input?: string; inMode?: boolean }>();
  readonly typed: { pane: string; text: string }[] = [];
  readonly enters: string[] = [];
  /** When false, typed text does not show up in the box. */
  echo = true;
  readonly buffers = new Map<string, string>();
  readonly pasted: { pane: string; text: string; file?: string }[] = [];
  private lastFile: string | undefined;

  async run(command: TmuxCommand, args: readonly string[]): Promise<TmuxResult> {
    if (command === 'load-buffer') {
      // load-buffer -b <name> <file>: the file must be there, with the text, while tmux reads it.
      const file = args.at(-1)!;
      this.lastFile = file;
      this.buffers.set(args[args.indexOf('-b') + 1]!, readFileSync(file, 'utf8'));
      return { code: 0, stdout: '', stderr: '' };
    }
    const target = args[args.indexOf('-t') + 1] ?? '';
    const pane = this.panes.get(target) ?? [...this.panes.values()].find((candidate) => candidate.session === target);
    if (!pane) return { code: 1, stdout: '', stderr: 'no pane' };
    if (command === 'display-message') {
      const format = args.at(-1);
      if (format === '#{session_name}\t#{pane_pid}') return { code: 0, stdout: `${pane.session}\t${pane.pid}\n`, stderr: '' };
      if (format === '#{session_activity}') return { code: 0, stdout: `${pane.activity}\n`, stderr: '' };
      if (format === '#{pane_in_mode}') return { code: 0, stdout: pane.inMode ? '1\n' : '0\n', stderr: '' };
    }
    if (command === 'capture-pane') return { code: 0, stdout: pane.screen, stderr: '' };
    if (command === 'paste-buffer') {
      // As Claude Code 2.1.322 shows a bracketed paste: a long one as "[Pasted text #1 +N lines]", a short one as it is.
      const text = this.buffers.get(args[args.indexOf('-b') + 1]!) ?? '';
      this.pasted.push({ pane: target, text, file: this.lastFile });
      if (!args.includes('-p')) return { code: 1, stdout: '', stderr: 'not a bracketed paste' };
      // After what was typed: a long paste as its placeholder, a short one as it is.
      const input = `${pane.input ?? ''}${text.length > 800 ? ` [Pasted text #1 +${text.split('\n').length} lines]` : text}`;
      pane.input = input;
      const lines = input.split('\n');
      pane.screen = ['⏺ fatto', RULE, `❯ ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`), RULE, '  footer'].join('\n');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'send-keys') {
      if (args.includes('-H')) {
        const text = Buffer.from(args.slice(args.indexOf('-H') + 1).join(''), 'hex').toString('utf8');
        this.typed.push({ pane: target, text });
        pane.input = text;
        if (this.echo) pane.screen = box(text);
      } else if (args.at(-1) === 'Enter') {
        this.enters.push(target);
        pane.input = '';
        const typed = /❯ (.*)/.exec(pane.screen)?.[1] ?? '';
        pane.screen = pane.afterEnter ? pane.afterEnter(typed) : box('');
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${command}` };
  }
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let registry: Registry;
let commander: Commander;
let tmux: FakeTmux;
const logs: string[] = [];

function setup(notes?: ResetNotes): void {
  registry = new Registry({ settleMs: 5, onChange: (agent) => commander?.agentChanged(agent) });
  tmux = new FakeTmux();
  for (const [id, session, pane, pid] of [
    [A, 'fk-11111111', '%1', 101],
    [B, 'fk-22222222', '%2', 202],
  ] as const) {
    registry.register({ id, cwd: `/p/${session}`, tmuxSession: session });
    registry.hook({ hook_event_name: 'SessionStart', session_id: `s-${id}`, source: 'startup', cwd: `/p/${session}`, transcript_path: `/t/${id}.jsonl` }, { agentId: id, pid, pane });
    registry.agents.get(id)!.state = 'idle';
    tmux.panes.set(pane, { session, pid, screen: box(''), activity: 0 });
  }
  commander = new Commander({ registry, tmux, log: (line) => logs.push(line), notes, sleep: async () => {}, settleMs: 0, tickMs: 60_000, typingQuietMs: 10_000 });
}

afterEach(() => {
  commander?.stop();
  registry?.dispose();
});

const hook = (id: string, payload: Omit<HookPayload, 'session_id'>): void => {
  commander.hook(registry.hook({ ...payload, session_id: `s-${id}` }), { ...payload, session_id: `s-${id}` });
};
const status = (id: string): string | undefined => registry.agents.get(id)?.commands?.at(-1)?.status;
const settle = (): Promise<void> => sleep(15);

describe('commands of the box', () => {
  it('types /compact into the right pane, presses Enter after it shows, and waits for PostCompact', async () => {
    setup();
    expect(commander.enqueue(A, 'compact').ok).toBe(true);
    await settle();
    expect(tmux.typed).toEqual([{ pane: '%1', text: '/compact' }]);
    expect(tmux.enters).toEqual(['%1']);
    expect(status(A)).toBe('inviato');
    // Another session compacting is not the confirmation.
    hook(B, { hook_event_name: 'PreCompact', trigger: 'manual' });
    expect(status(A)).toBe('inviato');
    hook(A, { hook_event_name: 'PreCompact', trigger: 'manual' });
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'inviato', reason: 'compacting' });
    hook(A, { hook_event_name: 'PostCompact', trigger: 'manual' });
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'confermato', reason: 'compaction done' });
    expect(registry.agents.get(B)!.commands).toBeUndefined();
  });

  it('says so when Claude Code starts a compaction and gives up on it (PreCompact, then no PostCompact)', async () => {
    setup();
    commander.enqueue(A, 'compact');
    await settle();
    hook(A, { hook_event_name: 'PreCompact', trigger: 'manual' });
    expect(registry.agents.get(A)!.state).toBe('compacting');
    // "Not enough messages to compact": no hook; claude agents --json says idle once the hooks are quiet.
    const agent = registry.agents.get(A)!;
    agent.lastEvent.at -= 60_000;
    registry.reconcile([{ pid: 101, sessionId: `s-${A}`, status: 'idle' }], [], () => true);
    expect(agent.state).toBe('idle');
    expect(agent.commands![0]).toMatchObject({ status: 'non-confermato' });
  });

  it('keeps commands in a queue while Claude works or waits for you, and never types into a dialog', async () => {
    setup();
    const agent = registry.agents.get(A)!;
    registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: `s-${A}`, prompt: 'vai' });
    commander.enqueue(A, 'compact');
    await settle();
    expect(agent.commands![0]).toMatchObject({ status: 'in-coda', reason: 'waiting for the turn to end' });
    registry.hook({ hook_event_name: 'PermissionRequest', session_id: `s-${A}`, tool_name: 'Bash', tool_input: { command: 'rm -rf x' } });
    commander.tick();
    await settle();
    expect(agent.commands![0]).toMatchObject({ status: 'in-coda', reason: 'Claude waits for your answer' });
    expect(tmux.typed).toEqual([]);
    // The turn ends: the command goes.
    registry.hook({ hook_event_name: 'Stop', session_id: `s-${A}`, last_assistant_message: 'ok' });
    await settle();
    expect(tmux.typed).toEqual([{ pane: '%1', text: '/compact' }]);
  });

  it('never touches a draft, and goes once it is gone', async () => {
    setup();
    tmux.panes.get('%1')!.screen = box('una bozza mia');
    commander.enqueue(A, 'compact');
    await settle();
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'bloccato', reason: 'there is text in the prompt: it stays as it is' });
    expect(tmux.typed).toEqual([]);
    tmux.panes.get('%1')!.screen = box('');
    commander.tick();
    await settle();
    expect(status(A)).toBe('inviato');
  });

  it('waits while someone types into the session, or while the answer of /btw is open', async () => {
    setup();
    tmux.panes.get('%1')!.activity = Math.floor(Date.now() / 1000);
    commander.enqueue(A, 'compact');
    await settle();
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'in-coda', reason: 'you are typing in the session: waiting' });
    tmux.panes.get('%1')!.activity = 0;
    tmux.panes.get('%1')!.screen = BTW_OPEN('/btw domanda');
    commander.tick();
    await settle();
    expect(registry.agents.get(A)!.commands![0]!.status).toBe('bloccato');
    expect(tmux.typed).toEqual([]);
  });

  it('stops when the pane is no longer the one of that claude process', async () => {
    setup();
    tmux.panes.get('%1')!.pid = 999;
    commander.enqueue(A, 'compact');
    await settle();
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'fallito', reason: 'the pane no longer belongs to the session' });
    expect(tmux.typed).toEqual([]);
  });

  it('does not press Enter when the prompt does not show the command as typed', async () => {
    setup();
    tmux.echo = false;
    commander.enqueue(A, 'compact');
    await settle();
    expect(status(A)).toBe('fallito');
    expect(tmux.enters).toEqual([]);
  });

  it('asks for /clear to be confirmed, and confirms it with the SessionStart of the same process', async () => {
    setup();
    expect(commander.enqueue(A, 'clear')).toEqual({ ok: false, error: '/clear va confermato' });
    expect(commander.enqueue(A, 'clear', undefined, true).ok).toBe(true);
    await settle();
    expect(tmux.typed).toEqual([{ pane: '%1', text: '/clear' }]);
    hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
    expect(status(A)).toBe('confermato');
  });

  it('lets arricurdAI prepare its note before /clear, and does not clear when it fails', async () => {
    const prepared: string[] = [];
    setup({ supported: async () => true, prepare: async (path) => void prepared.push(path) });
    commander.enqueue(A, 'clear', undefined, true);
    await settle();
    expect(prepared).toEqual([`/t/${A}.jsonl`]);
    expect(tmux.typed).toHaveLength(1);

    setup({ supported: async () => true, prepare: async () => Promise.reject(new Error('disco pieno')) });
    commander.enqueue(A, 'clear', undefined, true);
    await settle();
    expect(status(A)).toBe('fallito');
    expect(tmux.typed).toEqual([]);
  });

  it('sends /btw on one line, and counts it as delivered when its answer box shows the question', async () => {
    setup();
    tmux.panes.get('%1')!.afterEnter = (typed) => BTW_OPEN(typed);
    commander.enqueue(A, 'btw', 'quanto fa\n17 per 3?');
    await settle();
    expect(tmux.typed).toEqual([{ pane: '%1', text: '/btw quanto fa 17 per 3?' }]);
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'confermato', reason: 'the answer is in the terminal' });
    expect(commander.enqueue(A, 'btw', '   ')).toEqual({ ok: false, error: 'the question is missing' });
  });

  it('says so when no confirmation comes, takes back a command still waiting, and drops the queue of an ended session', async () => {
    setup();
    let now = Date.now();
    commander.stop();
    commander = new Commander({ registry, tmux, log: () => {}, sleep: async () => {}, settleMs: 0, tickMs: 60_000, now: () => now });
    commander.enqueue(A, 'compact');
    await settle();
    now += 31_000;
    commander.tick();
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'non-confermato' });

    registry.hook({ hook_event_name: 'UserPromptSubmit', session_id: `s-${B}`, prompt: 'vai' });
    const queued = commander.enqueue(B, 'compact');
    expect(queued.ok && commander.cancel(B, queued.command.id)).toBe(true);
    expect(registry.agents.get(B)!.commands).toEqual([]);

    commander.enqueue(B, 'compact');
    registry.hook({ hook_event_name: 'SessionEnd', session_id: `s-${B}`, reason: 'prompt_input_exit' });
    commander.agentChanged(registry.agents.get(B)!);
    expect(registry.agents.get(B)!.commands).toEqual([]);
  });

  it('refuses sessions in read-only and unknown commands', () => {
    setup();
    registry.hook({ hook_event_name: 'SessionStart', session_id: 's-readonly', source: 'startup', cwd: '/x' });
    const readonly = registry.list().find((agent) => agent.control.kind === 'readonly')!;
    expect(commander.enqueue(readonly.id, 'compact')).toEqual({ ok: false, error: 'the session is read only or ended' });
    expect(commander.enqueue(A, 'exit')).toEqual({ ok: false, error: 'unknown command: exit' });
  });
});

describe('requests of a team', () => {
  const seen: string[] = [];
  const setupRequests = (): void => {
    setup();
    commander.stop();
    seen.length = 0;
    commander = new Commander({
      registry,
      tmux,
      log: (line) => logs.push(line),
      sleep: async () => {},
      settleMs: 0,
      tickMs: 60_000,
      typingQuietMs: 10_000,
      onRequest: (_agent, command) => seen.push(command.status),
    });
  };

  it('pastes a request, newlines and all, into the right pane, presses Enter, and UserPromptSubmit confirms it', async () => {
    setupRequests();
    const text = 'Request #1 from the user:\nWrite the tests of the parser.\nThen run them.';
    expect(commander.enqueueRequest(A, text, { crew: 'c1', n: 1 }).ok).toBe(true);
    await settle();
    // The first line typed, as words of the user; the rest pasted on a line of its own; the file of the text gone.
    expect(tmux.typed).toEqual([{ pane: '%1', text: 'Request #1 from the user:' }]);
    expect(tmux.pasted.map(({ pane, text }) => ({ pane, text }))).toEqual([{ pane: '%1', text: '\nWrite the tests of the parser.\nThen run them.' }]);
    expect(existsSync(tmux.pasted[0]!.file!)).toBe(false);
    expect(tmux.enters).toEqual(['%1']);
    expect(status(A)).toBe('inviato');
    hook(A, { hook_event_name: 'UserPromptSubmit', prompt: 'something you typed' });
    expect(status(A)).toBe('inviato');
    hook(A, { hook_event_name: 'UserPromptSubmit', prompt: text });
    expect(status(A)).toBe('confermato');
    expect(seen).toEqual(['in-coda', 'inviato', 'confermato']);
    expect(registry.agents.get(A)?.commands?.at(-1)).toMatchObject({ kind: 'request', request: { crew: 'c1', n: 1 } });
  });

  it('a long request shows as a pasted text, and that is enough to press Enter', async () => {
    setupRequests();
    const text = `Request #2 from the user:\n${'a line of the request\n'.repeat(60)}the end`;
    commander.enqueueRequest(B, text, { crew: 'c1', n: 2 });
    await settle();
    expect(tmux.pasted[0]?.text).toBe(`\n${'a line of the request\n'.repeat(60)}the end`);
    expect(tmux.enters).toEqual(['%2']);
    // Claude Code hands a long paste on inside <pasted_content>, after the first line typed: that confirms it.
    hook(B, { hook_event_name: 'UserPromptSubmit', prompt: 'Request #2 from the user: <pasted_content id="d58c">\na line…</pasted_content>' });
    expect(status(B)).toBe('confermato');
  });

  it('waits while the session works, and is never pasted into a dialog', async () => {
    setupRequests();
    registry.agents.get(A)!.state = 'working';
    commander.enqueueRequest(A, 'Request #3 from the user:\nGo on.', { crew: 'c1', n: 3 });
    await settle();
    expect(tmux.pasted).toEqual([]);
    expect(status(A)).toBe('in-coda');
    // The turn ends, but a dialog is open where the box should be.
    tmux.panes.get('%1')!.screen = BTW_OPEN('why?');
    registry.agents.get(A)!.state = 'idle';
    commander.tick();
    await settle();
    expect(tmux.pasted).toEqual([]);
    expect(status(A)).toBe('bloccato');
    // Closed: it goes.
    tmux.panes.get('%1')!.screen = box('');
    commander.tick();
    await settle();
    expect(tmux.pasted).toHaveLength(1);
    expect(status(A)).toBe('inviato');
  });

  it('looks at the prompt once more when Claude Code has not drawn the paste yet', async () => {
    setupRequests();
    const text = 'Request #9 from the user:\nGo on.';
    // The first look finds the box still empty; the second, the request.
    const pane = tmux.panes.get('%1')!;
    let looks = 0;
    const real = tmux.run.bind(tmux);
    tmux.run = async (command, args) => {
      if (command === 'capture-pane' && pane.input && looks++ === 0) return { code: 0, stdout: box(''), stderr: '' };
      return real(command, args);
    };
    commander.enqueueRequest(A, text, { crew: 'c1', n: 9 });
    await settle();
    expect(tmux.enters).toEqual(['%1']);
    expect(status(A)).toBe('inviato');
  });

  it('takes out control characters, and refuses an empty or too long one', () => {
    setupRequests();
    const queued = commander.enqueueRequest(A, 'Request #4 from the user:\r\nGo\u001b[2J on\u0007.', { crew: 'c1', n: 4 });
    expect(queued.ok && queued.command.arg).toBe('Request #4 from the user:\nGo[2J on.');
    expect(commander.enqueueRequest(A, ' \u0000 ', { crew: 'c1', n: 5 })).toEqual({ ok: false, error: 'the request is empty' });
    expect(commander.enqueueRequest(A, 'x'.repeat(20_001), { crew: 'c1', n: 6 }).ok).toBe(false);
    expect(commander.enqueueRequest('nobody', 'x', { crew: 'c1', n: 7 })).toEqual({ ok: false, error: 'unknown session' });
  });

  it('never types into a pane scrolled back (tmux copy mode), where the keys go to tmux', async () => {
    setupRequests();
    tmux.panes.get('%1')!.inMode = true;
    commander.enqueueRequest(A, 'Request #1 from the user:\nGo.', { crew: 'c1', n: 1 });
    expect(commander.enqueue(B, 'compact').ok).toBe(true);
    tmux.panes.get('%2')!.inMode = true;
    await settle();
    expect(tmux.typed).toEqual([]);
    expect(tmux.pasted).toEqual([]);
    expect(registry.agents.get(A)?.commands?.at(-1)).toMatchObject({ status: 'bloccato', reason: expect.stringContaining('copy mode') });
    // Back at the end: it goes.
    tmux.panes.get('%1')!.inMode = false;
    commander.tick();
    await settle();
    expect(tmux.enters).toEqual(['%1']);
  });

  it('the box cannot send a request: only a team can', () => {
    setupRequests();
    expect(commander.enqueue(A, 'request', 'Request #1 from the user:\nrm -rf')).toEqual({ ok: false, error: 'unknown command: request' });
  });
});

describe('the menu of a selection', () => {
  it('asks a question as your words: its first line typed, the quote pasted, confirmed by UserPromptSubmit', async () => {
    setup();
    expect(commander.enqueueAsk(A, 'perché 401?\n\n> Expected 200', true).ok).toBe(true);
    await settle();
    expect(tmux.typed).toEqual([{ pane: '%1', text: 'perché 401?' }]);
    expect(tmux.pasted.map((paste) => paste.text)).toEqual(['\n\n> Expected 200']);
    expect(tmux.enters).toEqual(['%1']);
    expect(status(A)).toBe('inviato');
    hook(A, { hook_event_name: 'UserPromptSubmit', prompt: 'perché 401?\n\n> Expected 200' });
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ kind: 'ask', status: 'confermato', reason: 'delivered' });
    expect(commander.enqueueAsk(A, '  \u0007 ', true)).toEqual({ ok: false, error: 'the question is empty' });
  });

  it('does not take the drag of the selection for typing, but waits for typing after it', async () => {
    setup();
    // The drag ended a moment ago: tmux counts it as activity of the session.
    tmux.panes.get('%1')!.activity = Math.floor(Date.now() / 1000);
    tmux.panes.get('%2')!.activity = Math.floor(Date.now() / 1000);
    commander.enqueueAsk(A, 'perché?', true);
    commander.enqueue(B, 'btw', 'perché?', false, true);
    await settle();
    expect(tmux.enters).toEqual(['%1', '%2']);

    hook(A, { hook_event_name: 'UserPromptSubmit', prompt: 'perché?' });
    hook(A, { hook_event_name: 'Stop' });
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'confermato' });

    // Typed after the question was asked: it waits, as for any command.
    tmux.panes.get('%1')!.activity = Math.floor(Date.now() / 1000) + 2;
    commander.enqueueAsk(A, 'e questo?', true);
    await settle();
    expect(registry.agents.get(A)!.commands!.at(-1)).toMatchObject({ status: 'in-coda', reason: 'you are typing in the session: waiting' });
  });

  it('counts the activity for a question to another session', async () => {
    setup();
    tmux.panes.get('%2')!.activity = Math.floor(Date.now() / 1000);
    commander.enqueueAsk(B, 'from elsewhere', false);
    await settle();
    expect(registry.agents.get(B)!.commands!.at(-1)).toMatchObject({ status: 'in-coda', reason: 'you are typing in the session: waiting' });
    expect(tmux.typed).toEqual([]);
  });

  it('puts text into the prompt without sending it, after what is typed', async () => {
    setup();
    const pane = tmux.panes.get('%1')!;
    pane.input = 'draft ';
    pane.screen = box('draft ');
    expect(await commander.insert(A, '> riga\n')).toEqual({ ok: true });
    expect(tmux.pasted.at(-1)?.text).toBe('> riga\n');
    expect(pane.input).toBe('draft > riga\n');
    expect(tmux.enters).toEqual([]);
    expect(registry.agents.get(A)!.commands).toBeUndefined();
    // While Claude works, too: the prompt is on screen.
    registry.agents.get(A)!.state = 'working';
    expect(await commander.insert(A, 'altro')).toEqual({ ok: true });
  });

  it('never puts text into a dialog, a pane scrolled back, or a session it does not run', async () => {
    setup();
    tmux.panes.get('%1')!.screen = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
    expect(await commander.insert(A, 'x')).toMatchObject({ ok: false, error: expect.stringContaining('dialog') as unknown });
    tmux.panes.get('%2')!.inMode = true;
    expect(await commander.insert(B, 'x')).toMatchObject({ ok: false, error: expect.stringContaining('scrolled back') as unknown });
    expect(await commander.insert('nope', 'x')).toEqual({ ok: false, error: 'unknown session' });
    expect(await commander.insert(B, '  ')).toEqual({ ok: false, error: 'nothing to put in' });
    expect(tmux.pasted).toEqual([]);
  });
});
