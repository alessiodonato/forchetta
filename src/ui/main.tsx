import { render } from 'preact';
import './styles.css';
import { App } from './App.tsx';
import { connectAttention } from './attention.ts';
import { browserShell } from './browser-shell.ts';
import { Connection, shell } from './connection.ts';
import { setHidden } from './motion.ts';
import { IS_MAC, keepTextHere } from './platform.ts';
import { Store } from './store.ts';
import { applyTheme, savedTheme } from './theme.ts';

// The fonts of Windows and Linux, only there (styles.css).
if (!IS_MAC) {
  document.documentElement.dataset.os = 'other';
  keepTextHere(document.documentElement);
}

// The theme before the first render: no flash of the dark one on a light choice.
applyTheme(savedTheme(), false);

const store = new Store();
const connection = new Connection(store);
// For the tests of the app (and the curious): the terminals of the open panes.
window.forchettaDebug = { terminals: new Map(), store };

// Inside the app, the window says when it can be seen (minimized, covered, hidden); in a browser, the page does.
window.forchettaVisibility = (visible: boolean) => {
  setHidden(!visible);
  store.setVisible(visible);
  connection.setVisible(visible);
};
if (!shell()) {
  document.addEventListener('visibilitychange', () => window.forchettaVisibility?.(document.visibilityState === 'visible'));
}

// On a Mac the app shows them; the demo has notices of its own (it sets __FORCHETTA__, and no app is around it).
connectAttention(store, shell() ? (message) => shell()?.postMessage(message) : IS_MAC || window.__FORCHETTA__ ? undefined : browserShell());

render(<App store={store} />, document.getElementById('app')!);
connection.start();
