#!/usr/bin/env node
// Stands in for `arricurdai status --json` in the simulation: context and cache for the sessions sim-NN (12 to 15:
// a team of agents, for the screenshots), and for the sessions of scripts/dev/fake-agent.mjs found in the state of
// the test daemon, whose context grows with their age.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS = [120_000, 340_000, 610_000, 85_000, 880_000, 220_000, 45_000, 400_000, 150_000, 520_000, 460_000, 30_000, 210_000, 160_000, 95_000, 60_000];
const MINUTES_AGO = [1, 2, 5, 3, 0.5, 8, 20, 1, 4, 52, 75, 90, 0.5, 8, 1, 1];
const now = Date.now();
const session = (sessionId, context, minutesAgo, model) => {
  const lastCallAt = now - minutesAgo * 60_000;
  const expires = lastCallAt + 3_600_000;
  return {
    sessionId,
    model,
    context,
    lastCallAt: new Date(lastCallAt).toISOString(),
    cacheExpiresAt: new Date(expires).toISOString(),
    cacheLive: expires > now,
    guardWillStop: expires <= now && context >= 100_000,
  };
};
const sessions = TOKENS.map((context, index) =>
  session(`sim-${String(index).padStart(2, '0')}`, context, MINUTES_AGO[index], index === 6 || index === 15 ? 'claude-haiku-4-5' : 'claude-opus-5-5'),
);

const varDir = process.env.FORCHETTA_VAR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'var', 'sim');
try {
  const state = JSON.parse(readFileSync(join(varDir, 'state.json'), 'utf8'));
  for (const agent of state.agents ?? []) {
    if (!agent.sessionId || agent.sessionId.startsWith('sim-') || agent.state === 'ended') continue;
    const seed = [...agent.sessionId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const ageMin = Math.max(0, (now - (agent.createdAt ?? now)) / 60_000);
    sessions.push(session(agent.sessionId, 40_000 + (seed % 7) * 9_000 + Math.round(ageMin * 6_000), 0.2, agent.model ?? 'claude-opus-5-5'));
  }
} catch {
  // No state yet.
}
process.stdout.write(`${JSON.stringify({ generatedAt: new Date(now).toISOString(), hours: 24, minTokens: 100000, sessions })}\n`);
