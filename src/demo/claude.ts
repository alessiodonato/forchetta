// A Claude Code of the demo (from scripts/dev/fake-agent.mjs): it draws a screen like the one of Claude Code
// 2.1.32x in its terminal, takes typed keys and pastes, and sends the hooks of a real session to the daemon of the
// demo. What it does is a script picked from the words of the prompt: it reads and edits the files of the demo
// project for real (in memory), asks the guard before it writes, asks for permission before a command that
// deletes, answers /btw, /compact and /clear, starts a subagent, and in a team sends and answers requests.

import { hunks } from './diff.ts';
import { readText, putFile, existsSync } from './shims/fs.ts';
import { HOME } from './shims/os.ts';
import type { FakeTerminal } from './terminal.ts';

export interface GuardAnswer {
  decision: 'deny' | 'ask';
  reason: string;
}

export interface PermissionHandle {
  /** The answer from the box, if one comes. */
  answer: Promise<{ behavior: 'allow' | 'deny'; always: boolean } | undefined>;
  /** The dialog was answered in the terminal. */
  answeredInTerminal(yes: boolean): void;
}

export interface TeamTools {
  /** The members of the lead: name, and whether it answers. */
  members(): Array<{ name: string; answers: boolean }>;
  send(to: string[], text: string): { ok: true; n: number; to: string[] } | { ok: false; error: string };
  wait(requests: number[]): Promise<string>;
  ask(text: string): { ok: boolean; error?: string };
}

export interface SubagentScript {
  type: string;
  description: string;
  prompt: string;
  steps: Array<{ label: string; family: 'read' | 'shell' | 'edit' | 'other'; result: string; tool: string; input: Record<string, unknown> }>;
  report: string;
}

/** What the daemon of the demo does for a fake Claude. */
export interface ClaudeHost {
  hook(claude: FakeClaude, event: string, extra?: Record<string, unknown>): void;
  guard(claude: FakeClaude, tool: string, input: Record<string, unknown>): GuardAnswer | undefined;
  permission(claude: FakeClaude, payload: Record<string, unknown>): PermissionHandle;
  /** The status line: cost and context. */
  status(claude: FakeClaude): void;
  team(claude: FakeClaude): TeamTools | undefined;
  /** A subagent: its hooks and transcript, run by the daemon of the demo. Gives its id. */
  subagent(claude: FakeClaude, script: SubagentScript, toolUseId: string): Promise<string>;
  ended(claude: FakeClaude): void;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  undim: '\x1b[22m',
  gray: '\x1b[38;5;244m',
  light: '\x1b[38;5;246m',
  orange: '\x1b[38;5;174m',
  green: '\x1b[38;5;114m',
  red: '\x1b[38;5;203m',
  blue: '\x1b[38;5;110m',
  fg: '\x1b[39m',
  inverse: '\x1b[7m',
  noinverse: '\x1b[27m',
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Entry =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; name: string; arg: string; result?: string; error?: boolean; running?: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string };

type Segment = { text: string } | { paste: string; n: number };

/** A tool the guard stopped: Claude reads the reason and ends its turn. */
class Stopped extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A permission refused: Claude stops, with no Stop hook, and waits for the next prompt. */
class Refused extends Error {}

const GUARDED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const STALE = 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.';

export interface ClaudeInit {
  id: string;
  pid: number;
  cwd: string;
  terminal: FakeTerminal;
  host: ClaudeHost;
  name?: string;
  model?: string;
  mode?: string;
  firstPrompt?: string;
}

const MODEL_IDS: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' };

export class FakeClaude {
  readonly id: string;
  readonly pid: number;
  readonly cwd: string;
  readonly terminal: FakeTerminal;
  readonly name?: string;
  readonly model: string;
  readonly mode: string;
  sessionId = crypto.randomUUID();
  pane = '';
  session = '';
  /** What the status line says. */
  usd = 0;
  contextTokens: number | null = null;
  readonly contextWindow = 200_000;

  private readonly host: ClaudeHost;
  private entries: Entry[] = [];
  private input: Segment[] = [];
  private pastes = 0;
  private busySince: number | undefined;
  private busyWord = 'Thinking';
  private screen: 'prompt' | 'dialog' | 'btw' = 'prompt';
  private dialog: { title: string; detail: string; note?: string; options: string[]; selected: number; answer: (index: number) => void } | undefined;
  private btw: { question: string; answer?: string } | undefined;
  private readonly queue: string[] = [];
  private running = false;
  private interrupted = false;
  /** Files as this session last read them: an edit of a file changed since is refused, as in Claude Code. */
  private readonly readAs = new Map<string, string>();
  /** A task the guard held back, resumed by the notice that its file is free. */
  private waitingFor: { file: string; prompt: string } | undefined;
  private readonly alwaysAllowed = new Set<string>();
  private toolCount = 0;
  /** Prompts taken so far, for the tour. */
  promptCount = 0;
  private ended = false;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private pasting: string | undefined;

  constructor(init: ClaudeInit) {
    this.id = init.id;
    this.pid = init.pid;
    this.cwd = init.cwd;
    this.terminal = init.terminal;
    this.host = init.host;
    this.name = init.name;
    this.model = MODEL_IDS[init.model ?? ''] ?? 'claude-opus-5-5';
    this.mode = init.mode ?? '';
    this.terminal.onInput = (data) => this.onData(data);
    this.terminal.onResize = () => this.draw();
    if (init.firstPrompt) this.queue.push(init.firstPrompt);
  }

  get shownCwd(): string {
    return this.cwd === HOME || this.cwd.startsWith(`${HOME}/`) ? `~${this.cwd.slice(HOME.length)}` : this.cwd;
  }

  /** The session starts: its screen, its first hook, its first prompt if it has one. */
  start(): void {
    this.draw();
    this.ticker = setInterval(() => {
      if (this.busySince && this.screen === 'prompt') this.draw();
    }, 1000);
    setTimeout(() => {
      this.hook('SessionStart', { source: 'startup', model: this.model });
      this.contextTokens = null;
      this.usd = 0;
      this.host.status(this);
      if (this.queue.length > 0) void this.next();
    }, 500);
  }

  private hook(event: string, extra: Record<string, unknown> = {}): void {
    if (this.ended) return;
    this.host.hook(this, event, extra);
  }

  // ---- The screen ----------------------------------------------------------------------------------------

  private wrap(text: string, size: number): string[] {
    const out: string[] = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        if (word.length > size) {
          if (line) out.push(line);
          for (let index = 0; index < word.length; index += size) out.push(word.slice(index, index + size));
          line = out.pop() ?? '';
          continue;
        }
        if (line && line.length + 1 + word.length > size) {
          out.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      out.push(line);
    }
    return out;
  }

  private entryLines(entry: Entry, size: number): string[] {
    switch (entry.kind) {
      case 'prompt': {
        const lines = this.wrap(entry.text, size - 2);
        const shown = lines.length > 5 ? [...lines.slice(0, 4), '…'] : lines;
        return ['', ...shown.map((line, index) => `${C.gray}${index === 0 ? '> ' : '  '}${line}${C.fg}`)];
      }
      case 'tool': {
        const dot = entry.running ? `${C.gray}⏺${C.fg}` : entry.error ? `${C.red}⏺${C.fg}` : `${C.green}⏺${C.fg}`;
        return [
          '',
          `${dot} ${C.bold}${entry.name}${C.reset}(${entry.arg})`,
          ...(entry.result ? this.wrap(entry.result, size - 7).map((line, index) => `  ${entry.error ? C.red : C.gray}${index === 0 ? '⎿  ' : '   '}${line}${C.fg}`) : []),
        ];
      }
      case 'text':
        return ['', ...this.wrap(entry.text, size - 2).map((line, index) => `${index === 0 ? '⏺ ' : '  '}${line}`)];
      case 'note':
        return ['', ...this.wrap(entry.text, size - 2).map((line) => `${C.gray}  ${line}${C.fg}`)];
    }
  }

  private inputText(): string {
    return this.input.map((segment) => ('paste' in segment ? segment.paste : segment.text)).join('');
  }

  private boxLines(size: number): string[] {
    if (this.input.length === 0) return [`❯ ${C.dim}Try "add retries to src/api.ts"${C.undim}`];
    const shown = this.input
      .map((segment) => {
        if (!('paste' in segment)) return segment.text;
        const lines = segment.paste.split('\n').length;
        return segment.paste.length > 800 || lines > 3 ? `[Pasted text #${segment.n} +${lines - 1} lines]` : segment.paste;
      })
      .join('');
    return this.wrap(shown, size - 2).map((line, index) => `${index === 0 ? '❯ ' : '  '}${line}${index === this.wrap(shown, size - 2).length - 1 ? `${C.inverse} ${C.noinverse}` : ''}`);
  }

  private dialogLines(size: number): string[] {
    const dialog = this.dialog!;
    const inner = Math.min(size, 90) - 4;
    const border = (left: string, right: string): string => `${C.blue}${left}${'─'.repeat(inner + 2)}${right}${C.fg}`;
    const row = (text: string, raw = text): string => `${C.blue}│${C.fg} ${text}${' '.repeat(Math.max(0, inner - raw.length))} ${C.blue}│${C.fg}`;
    const body: string[] = [];
    body.push(row(`${C.bold}${dialog.title}${C.reset}`, dialog.title), row(''));
    for (const line of this.wrap(dialog.detail, inner - 2)) body.push(row(`  ${line}`, `  ${line}`));
    if (dialog.note) for (const line of this.wrap(dialog.note, inner - 2)) body.push(row(`  ${C.gray}${line}${C.fg}`, `  ${line}`));
    body.push(row(''), row('Do you want to proceed?'));
    dialog.options.forEach((option, index) => {
      const label = `${index + 1}. ${option}`;
      for (const [part, line] of this.wrap(label, inner - 2).entries()) {
        const mark = part === 0 && index === dialog.selected ? '❯ ' : '  ';
        const text = index === dialog.selected ? `${C.blue}${mark}${line}${C.fg}` : `${mark}${line}`;
        body.push(row(text, `${mark}${line}`));
      }
    });
    return [border('╭', '╮'), ...body, border('╰', '╯'), `  ${C.light}Esc to cancel${C.fg}`];
  }

  private btwLines(size: number): string[] {
    const btw = this.btw!;
    const lines = [`${C.gray}/btw ${btw.question}${C.fg}`, ''];
    if (btw.answer) lines.push(...this.wrap(btw.answer, size - 4).map((line, index) => `${index === 0 ? '⏺ ' : '  '}${line}`));
    else lines.push(`${C.orange}✻ Thinking…${C.fg}`);
    lines.push('', `  ${C.light}Press Esc to dismiss${C.fg}`);
    return lines;
  }

  draw(): void {
    if (this.ended) return;
    const size = Math.max(30, this.terminal.cols);
    const height = Math.max(8, this.terminal.rows);
    const rule = `${C.gray}${this.name ? `${'─'.repeat(Math.max(10, size - this.name.length - 3))} ${this.name} ─` : '─'.repeat(size)}${C.fg}`;
    let bottom: string[];
    if (this.screen === 'dialog' && this.dialog) bottom = this.dialogLines(size);
    else if (this.screen === 'btw' && this.btw) bottom = this.btwLines(size);
    else bottom = [rule, ...this.boxLines(size), `${C.gray}${'─'.repeat(size)}${C.fg}`, `  ${C.light}${this.mode ? `⏵⏵ ${this.mode} on · ` : ''}? for shortcuts${C.fg}`];
    const spinner = this.busySince && this.screen !== 'dialog' ? ['', `${C.orange}✻ ${this.busyWord}… ${C.gray}(${Math.round((Date.now() - this.busySince) / 1000)}s · esc to interrupt)${C.fg}`] : [];
    const width = Math.min(size, 60);
    const header = [
      `${C.orange}╭${'─'.repeat(width - 2)}╮${C.fg}`,
      `${C.orange}│${C.fg} ${C.orange}✻${C.fg} ${C.bold}Claude Code${C.reset} ${C.gray}· ${this.name ? `${this.name} · ` : ''}${this.model}${C.fg}`,
      `${C.orange}│${C.fg}   ${C.gray}${this.shownCwd}${C.fg}`,
      `${C.orange}╰${'─'.repeat(width - 2)}╯${C.fg}`,
    ];
    const body = [...header, ...this.entries.flatMap((entry) => this.entryLines(entry, size)), ...spinner, ''];
    const room = height - bottom.length;
    const lines = [...body.slice(Math.max(0, body.length - room)), ...bottom];
    while (lines.length < height) lines.splice(lines.length - bottom.length, 0, '');
    this.terminal.render(lines.slice(0, height));
  }

  // ---- The keys ------------------------------------------------------------------------------------------

  private onData(chunk: string): void {
    if (this.ended) return;
    let data = chunk;
    while (data.length > 0) {
      if (this.pasting !== undefined) {
        const end = data.indexOf('\x1b[201~');
        this.pasting += end < 0 ? data : data.slice(0, end);
        if (end < 0) return;
        if (this.screen === 'prompt') this.input.push({ paste: this.pasting.replace(/\r\n?/g, '\n'), n: ++this.pastes });
        this.pasting = undefined;
        data = data.slice(end + 6);
        continue;
      }
      if (data.startsWith('\x1b[200~')) {
        this.pasting = '';
        data = data.slice(6);
        continue;
      }
      const escape = /^\x1b(?:\[[0-9;?<]*[ -/]*[@-~]|O.)/.exec(data);
      if (escape) {
        this.key(escape[0]);
        data = data.slice(escape[0].length);
        continue;
      }
      this.key(data[0]!);
      data = data.slice(1);
    }
    this.draw();
  }

  private key(key: string): void {
    if (this.screen === 'dialog' && this.dialog) {
      const dialog = this.dialog;
      if (key === '\x1b[A' || key === '\x1bOA') dialog.selected = Math.max(0, dialog.selected - 1);
      else if (key === '\x1b[B' || key === '\x1bOB') dialog.selected = Math.min(dialog.options.length - 1, dialog.selected + 1);
      else if (key === '\r' || key === '\n') dialog.answer(dialog.selected);
      else if (/^[1-9]$/.test(key) && Number(key) <= dialog.options.length) dialog.answer(Number(key) - 1);
      else if (key === '\x1b') dialog.answer(dialog.options.length - 1);
      return;
    }
    if (this.screen === 'btw') {
      if (key === '\x1b' || key === '\r' || key === ' ') {
        this.screen = 'prompt';
        this.btw = undefined;
      }
      return;
    }
    if (key === '\r' || key === '\n') this.submit();
    else if (key === '\x7f' || key === '\b') {
      const last = this.input.at(-1);
      if (!last) return;
      if ('paste' in last || last.text.length <= 1) this.input.pop();
      else last.text = last.text.slice(0, -1);
    } else if (key === '\x03') this.input = [];
    else if (key === '\x1b') {
      if (this.running && this.busySince) this.interrupted = true;
    } else if (key.length === 1 && (key >= ' ' || key === '\t')) {
      const last = this.input.at(-1);
      if (last && !('paste' in last)) last.text += key;
      else this.input.push({ text: key });
    }
  }

  // ---- The turns -----------------------------------------------------------------------------------------

  private submit(): void {
    const prompt = this.inputText().trim();
    this.input = [];
    if (!prompt) return;
    if (prompt.startsWith('/btw ')) {
      void this.answerBtw(prompt.slice(5).trim());
      return;
    }
    this.queue.push(prompt);
    if (!this.running) void this.next();
  }

  private async answerBtw(question: string): Promise<void> {
    this.screen = 'btw';
    this.btw = { question };
    this.draw();
    await wait(1600);
    if (this.btw?.question !== question) return;
    this.btw.answer = btwAnswer(question, this);
    this.draw();
  }

  private async next(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0 && !this.ended) {
      const prompt = this.queue.shift()!;
      if (prompt === '/exit' || prompt === '/quit') {
        this.end('prompt_input_exit');
        return;
      }
      if (prompt === '/compact' || prompt.startsWith('/compact ')) {
        await this.compact();
        continue;
      }
      if (prompt === '/clear') {
        await this.clear();
        continue;
      }
      if (prompt.startsWith('/')) {
        this.entries.push({ kind: 'prompt', text: prompt }, { kind: 'note', text: `In this demo only /btw, /compact, /clear and /exit do something.` });
        this.draw();
        continue;
      }
      this.entries.push({ kind: 'prompt', text: prompt });
      this.busySince = Date.now();
      this.busyWord = 'Thinking';
      this.interrupted = false;
      this.draw();
      this.promptCount += 1;
      this.hook('UserPromptSubmit', { prompt });
      this.grow(1800 + prompt.length * 2);
      let reply: string | undefined;
      try {
        reply = await this.turn(prompt);
      } catch (error) {
        if (error instanceof Stopped) {
          await wait(1200);
          const held = /is changing (\S+) in the turn/.exec(error.reason)?.[1] ?? 'the file';
          const by = /"([^"]+)"/.exec(error.reason)?.[1] ?? 'another session';
          reply = `${held} is being changed by ${by} right now, so I won't touch it yet. I'll ${taskWords(prompt)} as soon as it is free.`;
          this.waitingFor = { file: held, prompt };
        } else if (error instanceof Refused) {
          this.busySince = undefined;
          this.entries.push({ kind: 'note', text: 'Stopped. Tell Claude what to do instead.' });
          this.draw();
          continue;
        } else reply = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (this.interrupted) {
        this.busySince = undefined;
        this.entries.push({ kind: 'note', text: 'Interrupted by user' });
        this.draw();
        this.hook('Stop', { last_assistant_message: 'Interrupted by user' });
        continue;
      }
      this.entries.push({ kind: 'text', text: reply });
      this.busySince = undefined;
      this.grow(900 + reply.length * 3);
      this.draw();
      this.hook('Stop', { last_assistant_message: reply });
    }
    this.running = false;
  }

  /** The context grows by about this many tokens, and the cost with it. */
  private grow(tokens: number): void {
    this.contextTokens = (this.contextTokens ?? 18_400) + Math.round(tokens);
    this.usd += tokens * 0.000045 + 0.012;
    this.host.status(this);
  }

  private async compact(): Promise<void> {
    this.entries.push({ kind: 'prompt', text: '/compact' });
    this.busySince = Date.now();
    this.busyWord = 'Compacting conversation';
    this.draw();
    this.hook('PreCompact', { trigger: 'manual', custom_instructions: '' });
    await wait(3200);
    this.contextTokens = null;
    this.host.status(this);
    this.entries = [{ kind: 'note', text: '✻ Conversation compacted (ctrl+o for history)' }];
    this.busySince = undefined;
    this.draw();
    this.hook('PostCompact', { trigger: 'manual' });
    this.hook('SessionStart', { source: 'compact', model: this.model });
    await wait(300);
    this.contextTokens = 9_800;
    this.host.status(this);
  }

  private async clear(): Promise<void> {
    this.hook('SessionEnd', { reason: 'clear' });
    this.entries = [];
    this.readAs.clear();
    this.waitingFor = undefined;
    this.sessionId = crypto.randomUUID();
    this.draw();
    await wait(400);
    this.hook('SessionStart', { source: 'clear', model: this.model });
    this.contextTokens = null;
    this.host.status(this);
  }

  /** The session ends: its pane says so, and the daemon hears it. */
  end(reason = 'other'): void {
    if (this.ended) return;
    this.hook('SessionEnd', { reason });
    this.ended = true;
    if (this.ticker) clearInterval(this.ticker);
    this.terminal.end();
    this.host.ended(this);
  }

  // ---- The tools -----------------------------------------------------------------------------------------

  private rel(path: string): string {
    return path.startsWith(`${this.cwd}/`) ? path.slice(this.cwd.length + 1) : path;
  }

  private abs(path: string): string {
    return path.startsWith('/') ? path : `${this.cwd}/${path}`;
  }

  /**
   * One tool: the guard, its hooks before and after, a permission when it needs one, and its lines on screen.
   * `run` does the work and gives the result line and the tool_response.
   */
  private async tool(name: string, input: Record<string, unknown>, arg: string, run: () => Promise<{ result: string; response?: unknown; error?: boolean }>, options: { permission?: { title: string; detail: string; note?: string; rule: string } } = {}): Promise<string> {
    if (this.interrupted) throw new Error('interrupted');
    this.busyWord = name === 'Bash' ? 'Running' : name.startsWith('mcp__') ? 'Waiting' : name === 'Agent' ? 'Delegating' : 'Working';
    const entry: Extract<Entry, { kind: 'tool' }> = { kind: 'tool', name: name.startsWith('mcp__') ? `forchetta - ${name.split('__')[2]} (MCP)` : name, arg, running: true };
    this.entries.push(entry);
    this.draw();
    const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const guard = GUARDED.has(name) ? this.host.guard(this, name, input) : undefined;
    this.hook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: toolUseId });
    if (guard?.decision === 'deny') {
      await wait(500);
      entry.running = false;
      entry.error = true;
      entry.result = `PreToolUse:${name} hook error: ${guard.reason}`;
      this.draw();
      this.hook('PostToolUseFailure', { tool_name: name, tool_input: input, tool_use_id: toolUseId, error: guard.reason });
      throw new Stopped(guard.reason);
    }
    const ask = options.permission && !this.alwaysAllowed.has(options.permission.rule) && this.mode !== 'auto' ? options.permission : guard?.decision === 'ask' ? { title: 'Bash command', detail: String(input.command ?? arg), note: guard.reason, rule: '' } : undefined;
    if (ask) {
      const allowed = await this.askPermission(name, input, ask);
      if (!allowed) {
        entry.running = false;
        entry.error = true;
        entry.result = allowed === false ? 'The user denied this request from Forchetta.' : "User rejected the tool use";
        this.busySince = undefined;
        this.draw();
        throw new Refused();
      }
    }
    this.toolCount += 1;
    const done = await run();
    entry.running = false;
    entry.result = done.result;
    entry.error = done.error;
    this.grow(500 + done.result.length * 4);
    this.draw();
    this.hook(done.error ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: name, tool_input: input, tool_use_id: toolUseId, tool_response: done.response ?? {} });
    if (done.error && done.result === STALE) throw new StaleFile(String(input.file_path ?? ''));
    return done.result;
  }

  /**
   * The permission dialog, in the terminal and in the box: true allowed, false denied from the box, undefined
   * refused in the terminal.
   */
  private askPermission(name: string, input: Record<string, unknown>, ask: { title: string; detail: string; note?: string; rule: string }): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      const suggestion = ask.rule ? [{ type: 'addRules', rules: [{ toolName: name, ruleContent: ask.rule }], behavior: 'allow', destination: 'localSettings' }] : [];
      this.hook('Notification', { notification_type: 'permission_prompt', message: `Claude needs your permission to use ${name}` });
      const handle = this.host.permission(this, { tool_name: name, tool_input: input, permission_suggestions: suggestion });
      let settled = false;
      const finish = (value: boolean | undefined): void => {
        if (settled) return;
        settled = true;
        this.screen = 'prompt';
        this.dialog = undefined;
        this.busySince = Date.now();
        this.draw();
        resolve(value);
      };
      const options = ['Yes', ...(ask.rule ? [`Yes, and don't ask again for ${ask.rule} commands in ${this.shownCwd}`] : []), 'No, and tell Claude what to do differently (esc)'];
      this.screen = 'dialog';
      this.dialog = {
        title: ask.title,
        detail: ask.detail,
        note: ask.note,
        options,
        selected: 0,
        answer: (index) => {
          const yes = index < options.length - 1;
          if (yes && index === 1 && ask.rule) this.alwaysAllowed.add(ask.rule);
          handle.answeredInTerminal(yes);
          finish(yes ? true : undefined);
        },
      };
      this.busySince = undefined;
      this.draw();
      void handle.answer.then((answer) => {
        if (!answer || settled) return;
        if (answer.behavior === 'allow' && answer.always && ask.rule) this.alwaysAllowed.add(ask.rule);
        finish(answer.behavior === 'allow' ? true : false);
      });
    });
  }

  private read(path: string, ms = 900): Promise<string> {
    const file = this.abs(path);
    return this.tool('Read', { file_path: file }, this.rel(file), async () => {
      await wait(ms);
      const text = readText(file);
      if (text === undefined) return { result: 'File does not exist.', error: true };
      this.readAs.set(file, text);
      return { result: `Read ${text.replace(/\n$/, '').split('\n').length} lines`, response: { type: 'text', file: { filePath: file, numLines: text.split('\n').length } } };
    });
  }

  /** An Edit: the change is a function of the text, so that it applies on top of the changes of others. */
  private edit(path: string, change: (text: string) => string, ms = 1400): Promise<string> {
    const file = this.abs(path);
    const before = readText(file) ?? '';
    const after = change(before);
    const { oldString, newString } = changedRegion(before, after);
    const input = { file_path: file, old_string: oldString, new_string: newString };
    return this.tool('Edit', input, this.rel(file), async () => {
      await wait(ms);
      const now = readText(file);
      if (now === undefined) return { result: 'File does not exist.', error: true };
      if (this.readAs.get(file) !== now) return { result: STALE, error: true };
      const next = change(now);
      if (next === now) return { result: 'No changes to make: the file already has them.', response: { filePath: file, structuredPatch: [] } };
      putFile(file, next);
      this.readAs.set(file, next);
      const patch = hunks(now, next);
      const added = patch.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('+')).length, 0);
      const removed = patch.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-')).length, 0);
      const counts = [added ? `${added} addition${added === 1 ? '' : 's'}` : '', removed ? `${removed} removal${removed === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
      return { result: `Updated ${this.rel(file)} with ${counts || 'no changes'}`, response: { filePath: file, oldString: input.old_string, newString: input.new_string, structuredPatch: patch } };
    });
  }

  private write(path: string, text: string, ms = 1300): Promise<string> {
    const file = this.abs(path);
    const created = !existsSync(file);
    return this.tool('Write', { file_path: file, content: text }, this.rel(file), async () => {
      await wait(ms);
      const before = readText(file);
      putFile(file, text);
      this.readAs.set(file, text);
      const lines = text.replace(/\n$/, '').split('\n').length;
      return created ? { result: `Wrote ${lines} lines to ${this.rel(file)}`, response: { type: 'create', filePath: file, content: text } } : { result: `Updated ${this.rel(file)}`, response: { type: 'update', filePath: file, content: text, structuredPatch: hunks(before ?? '', text) } };
    });
  }

  private bash(command: string, result: string, ms = 2000, permission?: { title: string; detail: string; note?: string; rule: string }, effect?: () => void): Promise<string> {
    return this.tool(
      'Bash',
      { command, description: '' },
      command,
      async () => {
        await wait(ms);
        effect?.();
        return { result, response: { stdout: result, stderr: '', interrupted: false } };
      },
      { permission },
    );
  }

  private grep(pattern: string, result: string, ms = 900): Promise<string> {
    return this.tool('Grep', { pattern, path: this.cwd }, `pattern: "${pattern}"`, async () => {
      await wait(ms);
      return { result };
    });
  }

  private say(text: string): void {
    this.entries.push({ kind: 'text', text });
    this.draw();
  }

  /** A turn: what the prompt asks, done by a script. */
  private async turn(prompt: string): Promise<string> {
    await wait(1000);
    const team = this.host.team(this);
    const request = /^Request #(\d+) from (.+?):\s*([\s\S]*)$/.exec(prompt);
    if (team && request && team.members().length > 0) return this.lead(team, request[3]!.trim());
    if (request) return this.member(request[3]!.trim());
    if (/^(Answer|Question) from /.test(prompt)) return 'Noted.';

    // The notice of the guard: the file is free, the task goes on.
    if (/ is free now /.test(prompt) && this.waitingFor) {
      const task = this.waitingFor.prompt;
      this.waitingFor = undefined;
      return this.task(task, true);
    }
    return this.task(prompt, false);
  }

  private async task(prompt: string, resumed: boolean): Promise<string> {
    const words = prompt.toLowerCase();
    try {
      if (/\bretr(y|ies)\b/.test(words)) return await this.retries();
      if (/\brate[ -]?limit|\blimit\b|throttl/.test(words)) return await this.rateLimit(resumed);
      if (/\b(build|clean|dist|deploy|rm )\b|\bdelete\b/.test(words)) return await this.build();
      if (/\b(explore|find|where|search|look|subagent|investigate)\b/.test(words)) return await this.explore(prompt);
      if (/\btests?\b/.test(words)) return await this.tests();
      if (/\b(readme|docs?|document)\b/.test(words)) return await this.docs();
      if (/^(hi|hello|hey|ciao|thanks|thank you)\b/.test(words)) return 'Hi! This is a demo session: the answers are scripted, but Forchetta around it is the real app. Try one of the tasks in the tutorial.';
      return await this.generic(prompt);
    } catch (error) {
      if (error instanceof StaleFile) {
        // As Claude does: read the file again, and build on what is there now.
        await this.read(this.rel(error.file), 700);
        this.say(`${this.rel(error.file)} has changes I didn't make. I'll fit my change around them.`);
        return this.task(prompt, true);
      }
      throw error;
    }
  }

  private async retries(): Promise<string> {
    await this.read('src/api.ts');
    await this.edit('src/api.ts', (text) =>
      text
        .replace(/^(import \{ http \} from '\.\/http';\n)(?!import \{ retry \})/m, "$1import { retry } from './retry';\n")
        .replace('  return http.order(id);', '  return retry(() => http.order(id));'),
    );
    await this.bash('npm test -- api', '✓ test/api.test.ts (12 tests)\n12 passed', 22_000);
    await this.edit('src/api.ts', (text) => text.replace('  return http.orders(client);', '  return retry(() => http.orders(client));'));
    await this.bash('npm test -- api', '✓ test/api.test.ts (12 tests)\n12 passed', 2600);
    return 'Retries are in: getOrder and listOrders in src/api.ts try a failed call 3 times, with a growing pause. The tests pass.';
  }

  private async rateLimit(resumed: boolean): Promise<string> {
    if (!resumed) await this.read('src/api.ts');
    else await this.read('src/api.ts', 700);
    await this.edit('src/api.ts', (text) => {
      let next = text;
      if (!next.includes("import { limit } from './limit';")) next = next.replace(/((?:^import .*\n)+)/m, "$1import { limit } from './limit';\n\nconst perClient = limit({ perMinute: 100 });\n");
      if (!next.includes('await perClient.take(client);')) next = next.replace(/(export async function listOrders\(client\) \{\n)/, '$1  await perClient.take(client);\n');
      return next;
    });
    await this.bash('npm test -- api', '✓ test/api.test.ts (13 tests)\n13 passed', 2400);
    return 'Done: listOrders now allows 100 requests a minute for each client, checked before anything else.';
  }

  private async build(): Promise<string> {
    await this.read('package.json', 700);
    await this.bash('rm -rf dist && npm run build', 'dist/index.js  4.1 kB\nBuilt in 1.4s', 2200, { title: 'Bash command', detail: 'rm -rf dist && npm run build', note: 'Delete the old build and build the project again', rule: 'rm -rf dist && npm run build' }, () => putFile(`${this.cwd}/dist/index.js`, '// built again\n'));
    return 'Built: the old dist/ is gone and the new build is in dist/index.js (4.1 kB).';
  }

  private async explore(prompt: string): Promise<string> {
    const script: SubagentScript = {
      type: 'Explore',
      description: 'Find where orders are read',
      prompt: `Find every place in this repository where an order is read or listed, and say which function each one calls. Context: ${prompt}`,
      steps: [
        { tool: 'Grep', label: 'Grep "getOrder|listOrders"', family: 'read', result: 'Found 4 matches in 3 files', input: { pattern: 'getOrder|listOrders' } },
        { tool: 'Read', label: 'Read src/orders.ts', family: 'read', result: 'Read 6 lines', input: { file_path: `${this.cwd}/src/orders.ts` } },
        { tool: 'Read', label: 'Read src/api.ts', family: 'read', result: 'Read 9 lines', input: { file_path: `${this.cwd}/src/api.ts` } },
        { tool: 'Read', label: 'Read test/api.test.ts', family: 'read', result: 'Read 8 lines', input: { file_path: `${this.cwd}/test/api.test.ts` } },
      ],
      report: 'Orders are read in two places: src/orders.ts calls getOrder (for the total), and test/api.test.ts calls it in its one test. listOrders is defined in src/api.ts but nothing calls it yet. Both go through src/http.ts.',
    };
    const toolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const input = { subagent_type: script.type, description: script.description, prompt: script.prompt };
    this.busyWord = 'Delegating';
    const entry: Extract<Entry, { kind: 'tool' }> = { kind: 'tool', name: `${script.type}`, arg: script.description, running: true };
    this.entries.push(entry);
    this.draw();
    this.hook('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId });
    const subagentId = await this.host.subagent(this, script, toolUseId);
    entry.running = false;
    entry.result = `Done (${script.steps.length} tool uses · 9.8k tokens · 14s)`;
    this.draw();
    this.hook('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId, tool_response: { status: 'completed', agentId: subagentId, totalTokens: 9800, totalToolUseCount: script.steps.length, content: [{ type: 'text', text: script.report }] } });
    this.grow(2400);
    return `I had an Explore subagent look. ${script.report}`;
  }

  private async tests(): Promise<string> {
    await this.read('src/orders.ts', 800);
    await this.write(
      'test/orders.test.ts',
      `import { describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';
import { orderTotal } from '../src/orders';

describe('orderTotal', () => {
  it('adds price times quantity', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue({ items: [{ price: 5, qty: 2 }, { price: 1, qty: 3 }] });
    expect(await orderTotal('1')).toBe(13);
  });
});
`,
    );
    await this.bash('npm test', '✓ test/api.test.ts (12 tests)\n✓ test/orders.test.ts (1 test)\n13 passed', 3600);
    return 'Added test/orders.test.ts: it checks that the total of an order is price × quantity for each item. All 13 tests pass.';
  }

  private async docs(): Promise<string> {
    await this.read('README.md', 700);
    await this.edit('README.md', (text) => (text.includes('## API') ? text : `${text}\n## API\n\n- \`getOrder(id)\`: one order\n- \`listOrders(client)\`: the orders of a client\n`));
    return 'README.md now has a short API section with getOrder and listOrders.';
  }

  private async generic(prompt: string): Promise<string> {
    await this.read('README.md', 700);
    await this.grep(prompt.split(/\s+/).find((word) => word.length > 4)?.replace(/[^\w-]/g, '') || 'order', 'Found 3 matches in 2 files', 800);
    return 'I had a look: this is a small shop with orders, a checkout form and an API client. In this demo my answers are scripted, and I know a few tasks: add retries to src/api.ts, add a rate limit, write tests, build the project (it asks a permission), or explore the code with a subagent.';
  }

  // ---- Teams ---------------------------------------------------------------------------------------------

  private async lead(team: TeamTools, goal: string): Promise<string> {
    await wait(800);
    const members = team.members();
    const builder = members.find((member) => member.name === 'developer') ?? members.find((member) => member.answers) ?? members[0]!;
    const checkers = members.filter((member) => member !== builder).map((member) => member.name);
    this.say(`I'll have ${builder.name} build it${checkers.length ? `, then ${checkers.join(' and ')} check it` : ''}.`);
    const built = await this.sendRequest(team, [builder.name], `${goal}\nBuild it in the repository, run the tests, and tell me which files you changed.`);
    if (built) await this.waitFor(team, [built]);
    if (checkers.length > 0) {
      const checked = await this.sendRequest(team, checkers, `Check the change of ${builder.name} for: ${goal}\n${checkers.includes('reviewer') ? 'reviewer: review the code, and fix what is wrong. ' : ''}${checkers.includes('tester') ? 'tester: write the tests and run them.' : ''}`.trim());
      if (checked) await this.waitFor(team, [checked]);
    }
    await wait(900);
    return `Done: ${goal.split('\n')[0]}. ${builder.name} built it${checkers.length ? `, ${checkers.join(' and ')} checked it` : ''}, and the tests pass.`;
  }

  private async sendRequest(team: TeamTools, to: string[], text: string): Promise<number | undefined> {
    let sent: ReturnType<TeamTools['send']> | undefined;
    const result = await this.tool('mcp__forchetta__send_request', { to, request: text }, `to: [${to.join(', ')}]`, async () => {
      await wait(500);
      sent = team.send(to, text);
      return sent.ok ? { result: `Request #${sent.n} is in the queue of ${sent.to.join(', ')}.` } : { result: sent.error, error: true };
    });
    return sent?.ok ? sent.n : (void result, undefined);
  }

  private async waitFor(team: TeamTools, requests: number[]): Promise<void> {
    await this.tool('mcp__forchetta__wait_for_answers', { requests }, `requests: [${requests.join(', ')}]`, async () => ({ result: await team.wait(requests) }));
  }

  private async member(goal: string): Promise<string> {
    const role = this.name ?? '';
    if (/review/.test(role)) {
      await this.read('src/api.ts', 900);
      await this.grep('getOrder', 'Found 4 matches in 3 files', 800);
      return 'Reviewed: the change is small and clear. One note: listOrders has no test yet. Nothing to fix.';
    }
    if (/test/.test(role)) return this.tests();
    await this.read('src/api.ts', 900);
    await this.edit('src/api.ts', (text) => (text.includes('export async function countOrders') ? text : `${text}\nexport async function countOrders(client) {\n  return (await listOrders(client)).length;\n}\n`));
    await this.bash('npm test -- api', '✓ test/api.test.ts (12 tests)\n12 passed', 2600);
    return `Done: ${goal.split('\n')[0]}. I added countOrders to src/api.ts, and the tests pass.`;
  }
}

/** An edit of a file changed since this session read it. */
class StaleFile extends Error {
  constructor(readonly file: string) {
    super(STALE);
  }
}

/** The part of a text an edit changes, as old_string and new_string. */
function changedRegion(before: string, after: string): { oldString: string; newString: string } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return { oldString: a.slice(start, a.length - end).join('\n'), newString: b.slice(start, b.length - end).join('\n') };
}

/** "add the rate limit": what Claude says it will do, from the prompt. */
function taskWords(prompt: string): string {
  const words = prompt.toLowerCase();
  if (/rate[ -]?limit|\blimit\b/.test(words)) return 'add the rate limit';
  if (/retr/.test(words)) return 'add the retries';
  return 'make the change';
}

/** The answer of /btw: a side question, answered without stopping the work. */
function btwAnswer(question: string, claude: FakeClaude): string {
  const words = question.toLowerCase();
  if (/file|chang|edit/.test(words)) return `So far I touched files in ${claude.shownCwd}: the panel "files" of my box in Forchetta lists them, with the diff of each.`;
  if (/test/.test(words)) return 'The tests run with npm test (vitest). There are 12 in test/api.test.ts.';
  if (/how long|when|done|finish/.test(words)) return 'A few more seconds: I am running the tests, then I make the last change.';
  return "That's a side question: I answer it here without stopping what I'm doing. (In this demo the answer is scripted.)";
}
