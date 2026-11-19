import { describe, expect, it } from 'vitest';
import { newAgent } from '../src/daemon/state.ts';
import type { Agent } from '../src/shared/agent.ts';
import type { CrewSummary } from '../src/shared/crew.ts';
import { railItems } from '../src/ui/Rail.tsx';

// The column of sessions next to the panes: the sessions of a team in one box with its name.

const agent = (id: string, crew?: string): Agent => ({ ...newAgent({ id, control: { kind: 'tmux', session: `fk-${id}` } }, 0), ...(crew ? { team: { crew } } : {}) });
const crew = (id: string, name: string, agentIds: string[]): CrewSummary => ({ id, name, recipients: agentIds.map((agentId, index) => ({ name: `m${index}`, agentId, ...(index === 0 ? { lead: true } : {}) })) }) as CrewSummary;

describe('the column of sessions', () => {
  it('puts the sessions of a team together, where the first of them was, in the order of its chart', () => {
    const agents = [agent('solo-1'), agent('dev', 'c1'), agent('solo-2'), agent('lead', 'c1'), agent('writer', 'c2'), agent('reviewer', 'c1')];
    const items = railItems(agents, [crew('c1', 'checkout', ['lead', 'dev', 'reviewer']), crew('c2', 'docs', ['writer'])]);
    expect(items.map((item) => (item.kind === 'agent' ? item.agent.id : `${item.crew.name}: ${item.agents.map((member) => member.id).join(', ')}`))).toEqual([
      'solo-1',
      'checkout: lead, dev, reviewer',
      'solo-2',
      'docs: writer',
    ]);
  });

  it('a session of a team that is not there any more stays on its own', () => {
    const items = railItems([agent('a', 'gone'), agent('b')], []);
    expect(items.map((item) => item.kind)).toEqual(['agent', 'agent']);
  });
});
