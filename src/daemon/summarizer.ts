import { type Agent, STATE_LABEL } from '../shared/agent.ts';
import { clip } from './labels.ts';

// The optional one-line summary written by a Haiku model (off by default: "summaries.haiku" in var/config.json).
// It runs only when the state of a session changes, at most once every 30 s per session, with the key in
// FORCHETTA_ANTHROPIC_API_KEY. It sends the last request, the recent actions and the last reply of the session
// to the Claude API: the only service outside this computer that Forchetta may talk to.

export const SUMMARY_SYSTEM =
  'Summarize in one line, in English, what a coding agent is doing or has just done. ' +
  'At most 90 characters, no quotes, no final period, no preamble. Describe the work, not the state.';

/** The text sent to the model: only what the box already shows or summarizes. */
export function summaryPrompt(agent: Agent): string {
  const parts = [`Project: ${agent.project}`, `State: ${STATE_LABEL[agent.state]}`];
  if (agent.lastPrompt) parts.push(`Last request of the user: ${agent.lastPrompt}`);
  if (agent.recentActions?.length) parts.push(`Recent actions: ${agent.recentActions.join('; ')}`);
  if (agent.waiting) parts.push(`Waiting for: ${agent.waiting.kind}${agent.waiting.detail ? ` (${agent.waiting.detail})` : ''}`);
  if (agent.lastReply) parts.push(`Last reply of the agent: ${agent.lastReply}`);
  return parts.join('\n');
}

/** One line from the model, or undefined when it declined or said nothing usable. */
export type Complete = (system: string, prompt: string) => Promise<string | undefined>;

export interface SummarizerOptions {
  complete: Complete;
  minIntervalMs: number;
  onSummary: (agentId: string, text: string) => void;
  log: (message: string) => void;
  now?: () => number;
  /** Wait for the events of a change to settle before asking. */
  settleMs?: number;
}

export class Summarizer {
  private readonly lastState = new Map<string, string>();
  private readonly lastCall = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pausedUntil = 0;
  private disabled = false;

  constructor(private readonly options: SummarizerOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Called after every change of an agent; acts only when its state is different from the last one seen. */
  changed(agent: Agent): void {
    if (this.disabled) return;
    const before = this.lastState.get(agent.id);
    this.lastState.set(agent.id, agent.state);
    if (before === agent.state || agent.state === 'ended' || agent.state === 'starting') return;
    if (!agent.lastPrompt && !agent.lastReply && !agent.recentActions?.length) return;
    const earliest = Math.max((this.lastCall.get(agent.id) ?? 0) + this.options.minIntervalMs, this.pausedUntil, this.now + (this.options.settleMs ?? 1500));
    const existing = this.timers.get(agent.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(agent.id);
      void this.summarize(agent);
    }, earliest - this.now);
    timer.unref?.();
    this.timers.set(agent.id, timer);
  }

  private async summarize(agent: Agent): Promise<void> {
    if (this.disabled || agent.state === 'ended') return;
    this.lastCall.set(agent.id, this.now);
    try {
      const text = await this.options.complete(SUMMARY_SYSTEM, summaryPrompt(agent));
      if (text) this.options.onSummary(agent.id, clip(text.replace(/^["'«]|["'»]$/g, ''), 120));
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 401 || status === 403) {
        this.disabled = true;
        this.options.log('riassunti Haiku disattivati: la chiave in FORCHETTA_ANTHROPIC_API_KEY non è valida');
      } else if (status === 429) {
        this.pausedUntil = this.now + 60_000;
        this.options.log('riassunti Haiku: limite di richieste, pausa di un minuto');
      } else {
        this.options.log(`riassunto Haiku non riuscito: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) {
      this.lastState.delete(id);
      this.lastCall.delete(id);
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  stop(): void {
    this.disabled = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** The call to the Claude API, with the SDK loaded only when the summaries are on. */
export async function haikuComplete(apiKey: string, model: string): Promise<Complete> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
  return async (system, prompt) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    // A declined request has no summary: the box keeps the one built from the events.
    if (response.stop_reason === 'refusal') return undefined;
    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join(' ')
      .trim();
    return text || undefined;
  };
}
