// The project of the demo: a small shop in ~/demo/<name>, a git repository with one commit. The sessions of the
// demo read and edit these files for real (in memory), so the panel of the changes shows real diffs.

import { commit } from './git.ts';
import { existsSync, mkdirSync, putFile } from './shims/fs.ts';
import { HOME } from './shims/os.ts';

export const DEMO_DIR = `${HOME}/demo`;

const FILES: Record<string, string> = {
  'package.json': `{
  "name": "shop",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "lint": "eslint src"
  }
}
`,
  'README.md': `# shop

A small web shop: orders, checkout and an API client.

- \`npm test\` runs the tests
- \`npm run build\` builds into dist/
`,
  'src/api.ts': `import { http } from './http';

export async function getOrder(id) {
  return http.order(id);
}

export async function listOrders(client) {
  return http.orders(client);
}
`,
  'src/http.ts': `export const http = {
  order: (id) => fetch(\`/api/orders/\${id}\`).then((r) => r.json()),
  orders: (client) => fetch(\`/api/orders?client=\${client}\`).then((r) => r.json()),
};
`,
  'src/orders.ts': `import { getOrder } from './api';

export async function orderTotal(id) {
  const order = await getOrder(id);
  return order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`,
  'src/checkout/form.tsx': `export function CheckoutForm({ onSubmit }) {
  return (
    <form onSubmit={onSubmit}>
      <input name="email" type="email" required />
      <button>Pay</button>
    </form>
  );
}
`,
  'test/api.test.ts': `import { describe, expect, it } from 'vitest';
import { getOrder } from '../src/api';

describe('api', () => {
  it('reads an order', async () => {
    expect(await getOrder('42')).toBeDefined();
  });
});
`,
  '.gitignore': `node_modules
dist
`,
};

/** Makes the folder of the project, with its files and its commit. Returns its path. */
export function createProject(name: string): string {
  const root = `${DEMO_DIR}/${name}`;
  if (existsSync(root)) return root;
  mkdirSync(root, { recursive: true });
  mkdirSync(`${root}/.git`, { recursive: true });
  putFile(`${root}/.git/HEAD`, 'ref: refs/heads/main\n');
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(FILES)) {
    putFile(`${root}/${path}`, text);
    files.set(path, text);
  }
  putFile(`${root}/dist/index.js`, '// built\n');
  commit(root, files);
  return root;
}

/** A project name as the demo accepts it. */
export const cleanName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'shop';
