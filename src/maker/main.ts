// The studio of forchetta.dev (Studio Maker): the studio of the app, alone, connected to a daemon that runs in this
// page (the one of the demo), to make a team and export it as a file for Forchetta. Nothing is started; what you
// make is kept in this browser as you go. The order of the imports matters, as in the demo.

import '../demo/shims/globals.ts';
import { DemoSocket } from '../demo/socket.ts';
import { loadSaved, saveSoon } from './saved.ts';
import { addFromGitHub, removeSkill } from './skills.ts';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = DemoSocket;
window.__FORCHETTA__ = { token: 'demo', port: 0 };

const { DemoDaemon } = await import('../demo/daemon.ts');
const daemon = new DemoDaemon({
  skills: {
    add: async (source) => {
      const added = await addFromGitHub(source);
      if (added.ok) saveSoon();
      return added;
    },
    remove: (id) => {
      const removed = removeSkill(id);
      if (removed.ok) saveSoon();
      return removed;
    },
  },
});
loadSaved(daemon);
(window as unknown as { forchettaMaker: unknown }).forchettaMaker = daemon;
await import('./app.tsx');
