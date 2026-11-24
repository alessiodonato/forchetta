// A small full screen program: shows the size, the keys it gets and the pastes.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\x1b[?2004h\x1b[2J\x1b[H');
let typed = '';
let events = [];
const draw = () => process.stdout.write(`\x1b[H\x1b[2J\x1b[1mTUI\x1b[0m ${process.stdout.columns}x${process.stdout.rows} è € 漢 ✻\r\n\x1b[2m> \x1b[0m${JSON.stringify(typed)}\r\n${events.slice(-6).join('\r\n')}\r\n`);
process.stdout.on('resize', draw);
process.stdin.on('data', (data) => {
  const text = data.toString('utf8');
  if (text === '\x03') { process.stdout.write('\x1b[?2004l'); process.exit(7); }
  events.push(`got ${JSON.stringify(text)}`);
  typed += text;
  draw();
});
draw();
