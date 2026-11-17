import { describe, expect, it } from 'vitest';
import type { CrewRequest, CrewSummary, Delivery } from '../src/shared/crew.ts';
import { arrivalsBetween, linkPath, linkStates, snapshotOf } from '../src/ui/org-lines.ts';

// The lines of a team in the org chart: what each one says, what flashes when something arrives, and where it runs.

const delivery = (to: string, status: Delivery['status'], patch: Partial<Delivery> = {}): Delivery => ({ to, agentId: `id-${to}`, status, at: 1, ...patch });
const request = (n: number, from: string, deliveries: Delivery[]): CrewRequest => ({ n, from, text: `request ${n}`, createdAt: n, deliveries });
/** A team with a Claude lead, or led by you (null). */
const team = (requests: CrewRequest[], lead: string | null = 'lead'): CrewSummary => ({
  id: 'c1',
  name: 'squad',
  ...(lead ? { lead } : {}),
  recipients: [...(lead ? [{ name: lead, agentId: 'id-lead', lead: true }] : []), { name: 'tester', agentId: 'id-tester' }, { name: 'writer', agentId: 'id-writer' }, { name: 'docs', agentId: 'id-docs' }],
  requests,
});

describe('the lines of a team', () => {
  it('say what goes on: working, queued, an answer on its way, a question; the strongest wins; the user aside', () => {
    const states = linkStates(
      team([
        request(1, 'lead', [delivery('tester', 'working'), delivery('writer', 'queued')]),
        request(2, 'lead', [delivery('docs', 'done', { reply: { status: 'queued' } })]),
        request(3, 'lead', [delivery('writer', 'working', { questions: [{ text: 'JSON?', at: 2, status: 'sent' }] })]),
        // Written by the user to a member of a team with a Claude lead: not along the line of the lead.
        request(4, 'the user', [delivery('tester', 'queued')]),
        request(5, 'lead', [delivery('lead', 'working')]),
      ]),
    );
    expect(Object.fromEntries(states)).toEqual({ 'id-tester': 'working', 'id-writer': 'question', 'id-docs': 'answer' });
    expect(linkStates(team([request(1, 'lead', [delivery('tester', 'done', { reply: { status: 'delivered' } })])])).size).toBe(0);
    expect(Object.fromEntries(linkStates(team([request(1, 'the user', [delivery('tester', 'sent')])], null)))).toEqual({ 'id-tester': 'working' });
  });

  it('flash what arrived since: a request that left the queue, an answer and a question that reached the lead; nothing at first', () => {
    const before = team([request(1, 'lead', [delivery('tester', 'queued'), delivery('writer', 'working'), delivery('docs', 'done', { reply: { status: 'queued' } })])]);
    expect(arrivalsBetween(undefined, before, 7)).toEqual([]);
    const after = team([
      request(1, 'lead', [
        delivery('tester', 'working'),
        delivery('writer', 'working', { questions: [{ text: 'Which file?', at: 3, status: 'sent' }] }),
        delivery('docs', 'done', { reply: { status: 'sent' } }),
      ]),
      request(2, 'lead', [delivery('docs', 'sent')]),
    ]);
    expect(arrivalsBetween(snapshotOf(before), after, 7).map((arrival) => [arrival.agentId, arrival.kind])).toEqual([
      ['id-tester', 'request'],
      ['id-writer', 'question'],
      ['id-docs', 'answer'],
      ['id-docs', 'request'],
    ]);
    // The same state again: nothing new arrived.
    expect(arrivalsBetween(snapshotOf(after), after, 8)).toEqual([]);
    // Delivered after sent: the answer had already arrived.
    const delivered = team([request(1, 'lead', [delivery('docs', 'done', { reply: { status: 'delivered' } })])]);
    expect(arrivalsBetween(snapshotOf(after), delivered, 9)).toEqual([]);
  });

  it('led by you: the answer is yours when the member finishes, and only then', () => {
    const working = team([request(1, 'the user', [delivery('tester', 'working')])], null);
    const done = team([request(1, 'the user', [delivery('tester', 'done', { answer: 'All green.' })])], null);
    expect(arrivalsBetween(snapshotOf(working), done, 1).map((arrival) => arrival.kind)).toEqual(['answer']);
    expect(arrivalsBetween(snapshotOf(done), done, 2)).toEqual([]);
    const oneway = team([request(1, 'the user', [delivery('tester', 'done')])], null);
    expect(arrivalsBetween(snapshotOf(working), oneway, 3)).toEqual([]);
  });

  it('run down from the lead to the middle of the gap, across, into the member; below the first row, along its gutter', () => {
    const lead = { left: 300, top: 0, width: 200, height: 100 };
    expect(linkPath(lead, { left: 0, top: 136, width: 296, height: 180 }, 136, 800)).toBe('M400.5 100.5 V118.5 H148.5 V136');
    expect(linkPath(lead, { left: 312, top: 332, width: 296, height: 180 }, 136, 800)).toBe('M400.5 100.5 V118.5 H304.5 V356.5 H312');
    // With no lead to draw from (its session is gone): from the middle, above the members.
    expect(linkPath(undefined, { left: 0, top: 136, width: 296, height: 180 }, 136, 800)).toBe('M400.5 100.5 V118.5 H148.5 V136');
  });
});
