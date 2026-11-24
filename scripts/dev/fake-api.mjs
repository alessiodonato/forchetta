// A stand-in for the API of Claude, for the end-to-end tests: Claude Code itself, with answers made here and no account.
// What the prompt says is what Claude does: "WRITE <file>" writes that file, "RUN <command>" runs it in the shell there is,
// "HOLD" keeps the turn open after it, until release().
import { createServer } from 'node:http';

export function fakeApi() {
  const waiting = new Set();
  const prompts = [];
  const tools = new Set();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST' || path !== '/v1/messages') {
        const counts = path.includes('count_tokens');
        res.writeHead(counts ? 200 : 404, { 'content-type': 'application/json' });
        return res.end(counts ? '{"input_tokens":10}' : '{"type":"error","error":{"type":"not_found_error","message":"no"}}');
      }
      const ask = JSON.parse(body || '{}');
      for (const tool of ask.tools ?? []) tools.add(tool.name);
      const names = (ask.tools ?? []).map((tool) => tool.name);
      const textOf = (message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
      const users = (ask.messages ?? []).filter((message) => message.role === 'user');
      const last = users.at(-1);
      const parts = Array.isArray(last?.content) ? last.content : [];
      const result = parts.find((part) => part.type === 'tool_result');
      // The prompt of the turn at hand: the last message of the user that is not the result of a tool.
      const asked = [...users].reverse().find((message) => !Array.isArray(message.content) || !message.content.some((part) => part.type === 'tool_result'));
      const text = asked ? textOf(asked) : '';
      let use;
      if (!result && names.length > 0) {
        prompts.push(text);
        const file = /WRITE (\S+)/.exec(text)?.[1];
        const command = /RUN (.+)/.exec(text)?.[1];
        if (file && names.includes('Write')) use = { name: 'Write', input: { file_path: file, content: `written at ${Date.now()}\n` } };
        else if (command) {
          const shell = names.includes('PowerShell') && (!names.includes('Bash') || text.includes('POWERSHELL')) ? 'PowerShell' : 'Bash';
          use = { name: shell, input: { command: command.trim(), description: 'what the test asks' } };
        }
      }
      if (result && text.includes('HOLD')) await new Promise((resolve) => waiting.add(resolve));
      const reply = result ? `done: ${JSON.stringify(result.content).slice(0, 400)}` : `You said: ${text.slice(-200)}`;
      const block = use ? { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 14)}`, name: use.name, input: {} } : { type: 'text', text: '' };
      const delta = use ? { type: 'input_json_delta', partial_json: JSON.stringify(use.input) } : { type: 'text_delta', text: reply };
      const usage = { input_tokens: 10, output_tokens: 5 };
      if (res.destroyed) return undefined;
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
      return res.end();
    });
  });
  const release = () => {
    for (const go of waiting) go();
    waiting.clear();
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, prompts, tools, release, holding: () => waiting.size, close: () => server.close() })));
}
