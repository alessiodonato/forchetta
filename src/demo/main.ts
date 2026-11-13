// The demo of forchetta.dev/demo: the page of the app (src/ui), unchanged, connected to a daemon that runs in this
// page (demo/daemon.ts) instead of the one on the Mac. The order of the imports matters: Node's globals and the
// fake WebSocket must be there before the daemon's modules and the page load.

import './shims/globals.ts';
import './demo.css';
import { DemoSocket } from './socket.ts';

(globalThis as unknown as { WebSocket: unknown }).WebSocket = DemoSocket;
window.__FORCHETTA__ = { token: 'demo', port: 0 };

const { DemoDaemon } = await import('./daemon.ts');
const { startTour, showNotice } = await import('./tour.ts');

const daemon = new DemoDaemon({ notify: (notice) => showNotice(notice) });
// For the tests of the demo, and the curious.
(window as unknown as { forchettaDemo: unknown }).forchettaDemo = daemon;
await import('../ui/main.tsx');
startTour(daemon);
