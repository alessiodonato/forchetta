import { describe, expect, it } from 'vitest';
import { isCheckCommand, isDevServerCommand, killTargets, placedCommands } from '../src/daemon/shell.ts';

// How the guard tells commands apart: tests and builds, dev servers, kills.

const words = (line: string): string[] => line.split(' ');

describe('tests, builds and linters', () => {
  it('are found in the usual ways of running them', () => {
    for (const line of [
      'npm test',
      'npm t',
      'pnpm build',
      'pnpm run typecheck',
      'yarn lint',
      'bun run test:unit',
      'npx vitest run',
      'pnpm exec tsc --noEmit',
      'vitest',
      'tsc -p .',
      'go test ./...',
      'cargo clippy',
      'python -m pytest -q',
      'pytest tests/api',
      'make',
      'turbo run build',
      'bundle exec rspec',
    ]) {
      expect(isCheckCommand(words(line)), line).toBe(true);
    }
  });

  it('are not the commands that start, install or look', () => {
    for (const line of ['npm run dev', 'npm start', 'pnpm install', 'pnpm add zod', 'npx tsx script.ts', 'ls -la', 'git status', 'go run .', 'cargo run', 'node build.js']) {
      expect(isCheckCommand(words(line)), line).toBe(false);
    }
  });
});

describe('dev servers', () => {
  it('are found by script, by program and by framework', () => {
    for (const line of [
      'npm run dev',
      'pnpm dev',
      'npm start',
      'yarn serve',
      'bun run dev:web',
      'vite',
      'vite --port 5174',
      'npx next dev',
      'pnpm exec astro dev',
      'python manage.py runserver',
      'python3 -m http.server 8000',
      'rails s',
      'php artisan serve',
      'uvicorn app:main --reload',
      'flask run',
    ]) {
      expect(isDevServerCommand(words(line)), line).toBe(true);
    }
  });

  it('are not builds, tests or other scripts', () => {
    for (const line of ['vite build', 'next build', 'pnpm build', 'npm test', 'npm run lint', 'python manage.py migrate', 'rails db:migrate', 'node server.js']) {
      expect(isDevServerCommand(words(line)), line).toBe(false);
    }
  });

  it('runs in the folder of the cd before it', () => {
    expect(placedCommands('cd apps/web && pnpm dev', '/p/shop')).toEqual([{ words: ['pnpm', 'dev'], dir: '/p/shop/apps/web' }]);
  });
});

describe('kills', () => {
  it('aim at pids, names, patterns and ports', () => {
    expect(killTargets('kill 123 456')).toEqual({ pids: [123, 456], patterns: [], ports: [] });
    expect(killTargets('kill -9 4242')).toEqual({ pids: [4242], patterns: [], ports: [] });
    expect(killTargets('pkill -f vite')).toEqual({ pids: [], patterns: [['-f', 'vite']], ports: [] });
    expect(killTargets('killall node')).toEqual({ pids: [], patterns: [['-x', 'node']], ports: [] });
    expect(killTargets('lsof -ti:3000 | xargs kill -9')).toEqual({ pids: [], patterns: [], ports: [3000] });
    expect(killTargets('kill $(lsof -ti:5173)')).toEqual({ pids: [], patterns: [], ports: [5173] });
    expect(killTargets('npx kill-port 3000')).toEqual({ pids: [], patterns: [], ports: [3000] });
    expect(killTargets('fuser -k 8080/tcp')).toEqual({ pids: [], patterns: [], ports: [8080] });
  });

  it('are not a look at a port, or the word kill in a message', () => {
    expect(killTargets('lsof -i :3000')).toBeUndefined();
    expect(killTargets('echo "kill the bug"')).toBeUndefined();
    expect(killTargets('git commit -m "kill 3 bugs"')).toBeUndefined();
  });
});
