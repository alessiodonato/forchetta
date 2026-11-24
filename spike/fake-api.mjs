// A stand-in for the API: a prompt with WRITE asks for the Write tool, SHELL for the shell tool there is, else text.
import { createServer } from 'node:http';
export const requests = [];
export const tools = new Set();
export function fakeApi(target) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      requests.push(`${req.method} ${path}`);
      if (req.method !== 'POST' || path !== '/v1/messages') { res.writeHead(path.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' }); return res.end(path.includes('count_tokens') ? '{"input_tokens":10}' : '{"type":"error","error":{"type":"not_found_error","message":"no"}}'); }
      let ask = {};
      try { ask = JSON.parse(body); } catch {}
      for (const tool of ask.tools ?? []) tools.add(tool.name);
      const last = [...(ask.messages ?? [])].reverse().find((m) => m.role === 'user');
      const parts = typeof last?.content === 'string' ? [{ type: 'text', text: last.content }] : last?.content ?? [];
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const result = parts.find((p) => p.type === 'tool_result');
      const names = (ask.tools ?? []).map((t) => t.name);
      let use;
      if (!result && names.length) {
        if (/\bWRITE\b/.test(text) && names.includes('Write')) use = { name: 'Write', input: { file_path: target, content: 'hello\n' } };
        else if (/\bSHELL\b/.test(text)) {
          const shell = /\bPOWERSHELL\b/.test(text) && names.includes('PowerShell') ? 'PowerShell' : names.includes('Bash') ? 'Bash' : names.includes('PowerShell') ? 'PowerShell' : undefined;
          if (shell) use = { name: shell, input: { command: 'echo from-the-shell', description: 'say something' } };
        }
      }
      const reply = result ? `done: ${JSON.stringify(result.content).slice(0, 120)}` : 'Hello from the fake API.';
      const block = use ? { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 14)}`, name: use.name, input: {} } : { type: 'text', text: '' };
      const delta = use ? { type: 'input_json_delta', partial_json: JSON.stringify(use.input) } : { type: 'text_delta', text: reply };
      const usage = { input_tokens: 10, output_tokens: 5 };
      if (!ask.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: ask.model, content: [use ? { ...block, input: use.input } : { type: 'text', text: reply }], stop_reason: use ? 'tool_use' : 'end_turn', stop_sequence: null, usage }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: ask.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      send('content_block_start', { index: 0, content_block: block });
      send('content_block_delta', { index: 0, delta });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: use ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
