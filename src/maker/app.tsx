import { render } from 'preact';
import '../ui/styles.css';
import './maker.css';
import { useStore } from '../ui/App.tsx';
import { Connection } from '../ui/connection.ts';
import { Store } from '../ui/store.ts';
import { restoreDraft, Studio, watchDraft } from '../ui/Studio.tsx';
import { keepCanvas, saveSoon, savedCanvas } from './saved.ts';

const store = new Store();
const connection = new Connection(store);
window.forchettaDebug = { terminals: new Map(), store };

// The canvas of last time, and every change of it kept; agents and teams saved go with it.
const canvas = savedCanvas();
if (canvas) restoreDraft(canvas);
watchDraft(keepCanvas);
let before = store.state;
store.subscribe(() => {
  if (store.state.roles !== before.roles || store.state.templates !== before.templates) saveSoon();
  before = store.state;
});

function Maker() {
  const state = useStore(store);
  if (!state.ready) return <p class="empty">Opening the studio…</p>;
  return <Studio agents={[]} store={store} maker onClose={() => {}} />;
}

render(<Maker />, document.getElementById('app')!);
connection.start();
