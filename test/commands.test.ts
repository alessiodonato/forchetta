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
  readonly panes = new Map<string, { session: string; pid: number; screen: string; activity: number; afterEnter?: (typed: string) => string }>();
  readonly typed: { pane: string; text: string }[] = [];
  readonly enters: string[] = [];
  /** When false, typed text does not show up in the box. */
  echo = true;

  async run(command: TmuxCommand, args: readonly string[]): Promise<TmuxResult> {
    const target = args[args.indexOf('-t') + 1] ?? '';
    const pane = this.panes.get(target) ?? [...this.panes.values()].find((candidate) => candidate.session === target);
    if (!pane) return { code: 1, stdout: '', stderr: 'no pane' };
    if (command === 'display-message') {
      const format = args.at(-1);
      if (format === '#{session_name}\t#{pane_pid}') return { code: 0, stdout: `${pane.session}\t${pane.pid}\n`, stderr: '' };
      if (format === '#{session_activity}') return { code: 0, stdout: `${pane.activity}\n`, stderr: '' };
    }
    if (command === 'capture-pane') return { code: 0, stdout: pane.screen, stderr: '' };
    if (command === 'send-keys') {
      if (args.includes('-H')) {
        const text = Buffer.from(args.slice(args.indexOf('-H') + 1).join(''), 'hex').toString('utf8');
        this.typed.push({ pane: target, text });
        if (this.echo) pane.screen = box(text);
      } else if (args.at(-1) === 'Enter') {
        this.enters.push(target);
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
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'inviato', reason: 'compattazione in corso' });
    hook(A, { hook_event_name: 'PostCompact', trigger: 'manual' });
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'confermato', reason: 'compattazione fatta' });
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
    expect(agent.commands![0]).toMatchObject({ status: 'in-coda', reason: 'aspetto la fine del turno' });
    registry.hook({ hook_event_name: 'PermissionRequest', session_id: `s-${A}`, tool_name: 'Bash', tool_input: { command: 'rm -rf x' } });
    commander.tick();
    await settle();
    expect(agent.commands![0]).toMatchObject({ status: 'in-coda', reason: 'Claude aspetta una tua risposta' });
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
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'bloccato', reason: "c'è del testo nel prompt: lo lascio com'è" });
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
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'in-coda', reason: 'stai scrivendo nella sessione: aspetto' });
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
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'fallito', reason: 'il pane non corrisponde più alla sessione' });
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
    expect(registry.agents.get(A)!.commands![0]).toMatchObject({ status: 'confermato', reason: 'la risposta è nel terminale' });
    expect(commander.enqueue(A, 'btw', '   ')).toEqual({ ok: false, error: 'manca la domanda' });
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
    expect(commander.enqueue(readonly.id, 'compact')).toEqual({ ok: false, error: 'sessione in sola lettura o terminata' });
    expect(commander.enqueue(A, 'exit')).toEqual({ ok: false, error: 'comando sconosciuto: exit' });
  });
});
