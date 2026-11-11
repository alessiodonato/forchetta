import { render } from 'preact';
import './styles.css';
import { App } from './App.tsx';
import { connectAttention } from './attention.ts';
import { Connection, shell } from './connection.ts';
import { setHidden } from './motion.ts';
import { Store } from './store.ts';

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

connectAttention(store, shell() ? (message) => shell()?.postMessage(message) : undefined);

render(<App store={store} />, document.getElementById('app')!);
connection.start();
