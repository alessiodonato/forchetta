// The hook as a program started with no shell: the input of Claude Code to the private pipe, the answer to stdout.
import { createConnection } from 'node:net';
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const socket = createConnection(process.argv[2]);
  let answer = '';
  const bye = () => { process.stdout.write(answer); process.exit(0); };
  setTimeout(() => process.exit(0), 3000).unref();
  socket.on('error', () => process.exit(0));
  socket.on('data', (c) => (answer += c));
  socket.on('end', bye);
  socket.write(`${JSON.stringify({ via: 'program', at: Date.now(), claudePid: Number(process.env.CLAUDE_PID) || undefined, parent: process.ppid, agent: process.env.FORCHETTA_AGENT, shell: process.env.SHELL, input: JSON.parse(input) })}\n`);
});
