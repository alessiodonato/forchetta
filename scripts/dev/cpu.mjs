#!/usr/bin/env node
// Average CPU of some processes over a window, from the CPU time ps reports at the start and at the end.
//   node scripts/dev/cpu.mjs <seconds> name=pid [name=pid ...]
import { execFileSync } from 'node:child_process';

const [seconds, ...targets] = process.argv.slice(2);
const pids = targets.map((target) => target.split('='));
const cpuSeconds = (pid) => {
  const text = execFileSync('ps', ['-o', 'time=', '-p', pid], { encoding: 'utf8' }).trim();
  const parts = text.split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};
const start = Object.fromEntries(pids.map(([name, pid]) => [name, cpuSeconds(pid)]));
await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000));
let total = 0;
for (const [name, pid] of pids) {
  const used = cpuSeconds(pid) - start[name];
  total += used;
  console.log(`  ${name.padEnd(12)} ${((used / Number(seconds)) * 100).toFixed(2)}%  (${used.toFixed(2)} s di CPU)`);
}
console.log(`  ${'totale'.padEnd(12)} ${((total / Number(seconds)) * 100).toFixed(2)}%`);
