#!/usr/bin/env node
// Stands in for `arricurdai status --json` in the simulation: context and cache for the sessions sim-NN (12 to 15:
// a team of agents, for the screenshots).
const TOKENS = [120_000, 340_000, 610_000, 85_000, 880_000, 220_000, 45_000, 400_000, 150_000, 520_000, 460_000, 30_000, 210_000, 160_000, 95_000, 60_000];
const MINUTES_AGO = [1, 2, 5, 3, 0.5, 8, 20, 1, 4, 52, 75, 90, 0.5, 8, 1, 1];
const now = Date.now();
const sessions = TOKENS.map((context, index) => {
  const lastCallAt = now - MINUTES_AGO[index] * 60_000;
  const expires = lastCallAt + 3_600_000;
  return {
    sessionId: `sim-${String(index).padStart(2, '0')}`,
    model: index === 6 || index === 15 ? 'claude-haiku-4-5' : 'claude-opus-5-5',
    context,
    lastCallAt: new Date(lastCallAt).toISOString(),
    cacheExpiresAt: new Date(expires).toISOString(),
    cacheLive: expires > now,
    guardWillStop: expires <= now && context >= 100_000,
  };
});
process.stdout.write(`${JSON.stringify({ generatedAt: new Date(now).toISOString(), hours: 24, minTokens: 100000, sessions })}\n`);
