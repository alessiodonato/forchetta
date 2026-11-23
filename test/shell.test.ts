import { describe, expect, it } from 'vitest';
import { globMatches, isCheckCommand, isDevServerCommand, killTargets, placedCommands, shellCommands, shellWrites, withoutHeredocs } from '../src/daemon/shell.ts';

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

  it('are not words that every object of JavaScript has', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) expect(isDevServerCommand([name, 'dev']), name).toBe(false);
  });

  it('runs in the folder of the cd before it', () => {
    expect(placedCommands('cd apps/web && pnpm dev', '/p/shop')).toEqual([{ words: ['pnpm', 'dev'], dir: '/p/shop/apps/web' }]);
  });
});

describe('here-documents', () => {
  const run = (line: string): string[] | undefined => shellCommands(line)?.map((command) => command.join(' '));

  it('are text for a program, not commands', () => {
    expect(run("cat > a.ts <<'EOF'\nclass A {\n  constructor() {}\n}\nnpm run dev\nkill 123\nEOF\necho done")).toEqual(['cat > a.ts <<EOF', 'echo done']);
    expect(run('python3 - <<PY\nimport os\ngit checkout .\nPY')).toEqual(['python3 - <<PY']);
    expect(killTargets("cat > stop.md <<'EOF'\nthen kill 4242\nEOF")).toBeUndefined();
    expect(placedCommands("tee notes.md <<EOF > /dev/null\nnpm run dev\nEOF\nnpm test", '/p').map((command) => command.words[0])).toEqual(['tee', 'npm']);
    // For a program on another computer, the commands are not of this one.
    expect(run('ssh prod <<EOF\nkill 4242\nEOF')).toEqual(['ssh prod <<EOF']);
  });

  it('with an apostrophe leave the rest of the line readable', () => {
    expect(run("cat > a.md <<'EOF'\nit's here\nEOF\ngit checkout .")).toEqual(['cat > a.md <<EOF', 'git checkout .']);
    expect(run("git commit -m \"$(cat <<'EOF'\nFix \"retries\", don't wait\n\nnpm run dev\nEOF\n)\" && npm test")?.at(-1)).toBe('npm test');
  });

  it('are commands for a shell', () => {
    for (const opener of ["bash <<'EOF'", 'sh -x <<EOF', '/bin/bash -s one <<EOF', 'sudo -u me bash <<EOF', 'env -i bash <<EOF', 'FOO=1 zsh <<EOF', "cat <<'EOF' | sh", 'cat <<EOF |& bash', 'cd x && bash <<EOF', 'if true; then bash <<EOF', '(bash <<EOF', '. /dev/stdin <<EOF', 'cat <<EOF |', 'bash \\\n  -s <<EOF']) {
      const commands = run(`${opener}\ngit checkout .\nkill 4242\nEOF\n`);
      expect(commands, opener).toContain('git checkout .');
      expect(commands, opener).not.toContain('EOF');
    }
    for (const opener of ["bash -c 'cat' <<EOF", 'sh -ec cat <<EOF', 'cat <<EOF || bash', 'cat <<EOF; bash', 'cat <<EOF 2>&1', 'while read x; do echo; done <<EOF', 'bashful <<EOF']) {
      expect(run(`${opener}\ngit checkout .\nEOF\n`), opener).not.toContain('git checkout .');
    }
  });

  it('inside the commands of a shell are text again', () => {
    expect(run("bash <<'A'\ncat > x <<'B'\nnpm run dev\nB\nkill 5\nA\nls")).toEqual(['bash <<A', 'cat > x <<B', 'kill 5', 'ls']);
  });

  it('more than one on a line, with tabs, with any word', () => {
    expect(run('cat <<A <<-"END OF B"\na\nA\nb\n\tEND OF B\nls')?.at(-1)).toBe('ls');
    expect(run('cat <<\\EOF-1\ngit checkout .\nEOF-1\nls')?.at(-1)).toBe('ls');
    expect(run('cat <<EOF\n  EOF\ngit checkout .\nEOF\nls')?.at(-1)).toBe('ls');
  });

  it('are not a << that opens none: the commands after it stay', () => {
    for (const first of ['echo "1 << n"', "echo '1 << n'", 'echo $((1 << n))', '(( x = 1 << n ))', 'grep x <<< word', 'ls # <<EOF', 'echo "a\n<<EOF b"', 'cat <<NEVER']) {
      expect(run(`${first}\ngit checkout .`), first).toContain('git checkout .');
    }
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

describe('the files a line writes', () => {
  const W = '/p/app';
  const paths = (line: string): string[] => shellWrites(line, W).map((write) => write.path);

  it('are the targets of > and >>, with the folder the line moved to', () => {
    expect(paths('echo hi > notes.md')).toEqual([`${W}/notes.md`]);
    expect(paths('echo hi >> notes.md')).toEqual([`${W}/notes.md`]);
    expect(paths('echo hi >notes.md')).toEqual([`${W}/notes.md`]);
    expect(paths('npm test 2> err.log')).toEqual([`${W}/err.log`]);
    expect(paths('npm test &> out.log')).toEqual([`${W}/out.log`]);
    expect(paths('cd src && echo x > a.ts')).toEqual([`${W}/src/a.ts`]);
    expect(paths('echo x > /abs/b.ts')).toEqual(['/abs/b.ts']);
  });

  it('are not a > in quotes, a copy of a descriptor, /dev/null, or a word with $ or ~', () => {
    expect(paths(`grep '>' notes.md`)).toEqual([]);
    expect(paths('echo "a > b"')).toEqual([]);
    expect(paths('npm test > /dev/null 2>&1')).toEqual([]);
    expect(paths('echo x >&2')).toEqual([]);
    expect(paths('echo x > "$OUT/a.txt"')).toEqual([]);
    expect(paths('echo x > ~/a.txt')).toEqual([]);
    expect(paths('git log --format=%h->%s')).toEqual([]);
  });

  it('follow a here-document to its file, not the text inside it', () => {
    const line = "cat > src/config.ts <<'EOF'\nexport const a = b > c ? 'it\\'s' : \"x\";\nconst d = 1; // don't > e.ts\nEOF\necho done > done.txt";
    expect(paths(line)).toEqual([`${W}/src/config.ts`, `${W}/done.txt`]);
    expect(withoutHeredocs("cat <<-END > a.md\n\tbody > b.md\n\tEND\nls")).toBe('cat <<-END > a.md\nls');
    // A script on stdin writes what it writes by itself: not seen.
    expect(paths("python3 - <<'PY'\nopen('a.py', 'w').write('x')\nPY")).toEqual([]);
  });

  it('are the files of tee, sed -i and perl -i', () => {
    expect(paths('echo x | tee -a a.log b.log')).toEqual([`${W}/a.log`, `${W}/b.log`]);
    expect(paths("sed -i '' 's/a/b/' src/a.ts")).toEqual([`${W}/src/a.ts`]);
    expect(paths("sed -i 's/a/b/' src/a.ts src/b.ts")).toEqual([`${W}/src/a.ts`, `${W}/src/b.ts`]);
    expect(paths("sed -i.bak -e 's/a/b/' -e 's/c/d/' a.ts")).toEqual([`${W}/a.ts`]);
    expect(paths("sed -Ei '' 's/a/b/' a.ts")).toEqual([`${W}/a.ts`]);
    expect(paths("sed --in-place -f fix.sed a.ts")).toEqual([`${W}/a.ts`]);
    expect(paths("perl -pi -e 's/a/b/' a.pl")).toEqual([`${W}/a.pl`]);
    expect(paths("perl -i.orig -pe 's/a/b/' a.pl b.pl")).toEqual([`${W}/a.pl`, `${W}/b.pl`]);
  });

  it('are not those sed and perl only read', () => {
    expect(paths("sed -n '1,5p' a.ts")).toEqual([]);
    expect(paths("sed 's/a/b/' a.ts > b.ts")).toEqual([`${W}/b.ts`]);
    expect(paths("perl -ne 'print' a.pl")).toEqual([]);
  });

  it('are the destination of cp and mv, and what rm and mv take away', () => {
    expect(shellWrites('cp a.ts b.ts', W)).toEqual([{ path: `${W}/b.ts` }]);
    expect(shellWrites('mv old.ts new.ts', W)).toEqual([{ path: `${W}/old.ts`, tree: true }, { path: `${W}/new.ts` }]);
    expect(shellWrites('rm -rf build', W)).toEqual([{ path: `${W}/build`, tree: true }]);
    expect(shellWrites('cp -t dest a b', W)).toEqual([]);
    expect(shellWrites('truncate -s 0 a.log', W)).toEqual([{ path: `${W}/a.log` }]);
  });

  it('can be a pattern', () => {
    expect(shellWrites("sed -i '' 's/a/b/' src/*.ts", W)).toEqual([{ path: `${W}/src/*.ts`, glob: true }]);
    expect(globMatches(`${W}/src/*.ts`, `${W}/src/a.ts`)).toBe(true);
    expect(globMatches(`${W}/src/*.ts`, `${W}/src/deep/a.ts`)).toBe(false);
    expect(globMatches(`${W}/src/**/*.ts`, `${W}/src/deep/a.ts`)).toBe(true);
    expect(globMatches(`${W}/src/**/*.ts`, `${W}/src/a.ts`)).toBe(true);
    expect(globMatches(`${W}/src/**`, `${W}/src/deep/a.ts`)).toBe(true);
    expect(globMatches(`${W}/a?.md`, `${W}/ab.md`)).toBe(true);
    expect(globMatches(`${W}/a.md`, `${W}/aXmd`)).toBe(false);
  });

  it('are what a formatter or a fixer rewrites: its paths, or the folder it runs in', () => {
    const formatted = (line: string): string[] => shellWrites(line, W).filter((write) => write.formatter).map((write) => write.path);
    expect(shellWrites('prettier --write src/a.ts', W)).toEqual([{ path: `${W}/src/a.ts`, tree: true, formatter: true }]);
    expect(formatted('npx prettier --write .')).toEqual([W]);
    expect(formatted('pnpm exec prettier -w --config .prettierrc src test')).toEqual([`${W}/src`, `${W}/test`]);
    expect(formatted('pnpm prettier --write "src/**/*.ts"')).toEqual([`${W}/src/**/*.ts`]);
    expect(formatted('eslint --fix')).toEqual([W]);
    expect(formatted('npx eslint --fix --ext .ts,.tsx src')).toEqual([`${W}/src`]);
    expect(formatted('npx @biomejs/biome check --write ./src')).toEqual([`${W}/src`]);
    expect(formatted('ruff format')).toEqual([W]);
    expect(formatted('uv run ruff check --fix app')).toEqual([`${W}/app`]);
    expect(formatted('python3 -m black --line-length 100 app tests')).toEqual([`${W}/app`, `${W}/tests`]);
    expect(formatted('go fmt ./...')).toEqual([W]);
    expect(formatted('gofmt -w ./pkg/...')).toEqual([`${W}/pkg`]);
    expect(formatted('cd crates/core && cargo fmt --all')).toEqual([`${W}/crates/core`]);
    expect(formatted('bundle exec rubocop -A')).toEqual([W]);
    expect(formatted('dart format lib')).toEqual([`${W}/lib`]);
    expect(formatted('terraform fmt -recursive')).toEqual([W]);
  });

  it('are the folder of a package script that formats or fixes', () => {
    const formatted = (line: string): string[] => shellWrites(line, W).filter((write) => write.formatter).map((write) => write.path);
    for (const line of ['npm run format', 'pnpm format', 'yarn fmt', 'pnpm run lint:fix', 'bun run format:write', 'pnpm lint --fix', 'npm run lint -- --fix']) {
      expect(formatted(line), line).toEqual([W]);
    }
    for (const line of ['npm run format:check', 'pnpm lint', 'npm test', 'pnpm build', 'pnpm run check-format']) expect(formatted(line), line).toEqual([]);
  });

  it('are not those of a formatter that only checks', () => {
    for (const line of ['prettier --check .', 'npx prettier src/a.ts', 'eslint .', 'eslint --fix-dry-run src', 'biome check ./src', 'ruff format --check', 'ruff check .', 'black --check app', 'isort --diff app', 'gofmt -l .', 'cargo fmt --check', 'rubocop', 'dart format -o none lib', 'terraform fmt -check', 'mix format --check-formatted', 'npx prettier --write "$DIR"', 'cargo fmt --version', 'ruff format --help']) {
      expect(shellWrites(line, W), line).toEqual([]);
    }
  });

  it('leave the words of shellCommands as they were', () => {
    expect(shellCommands("echo 'a > b' > c.txt; sed -i '' x f")).toEqual([['echo', 'a > b', '>', 'c.txt'], ['sed', '-i', '', 'x', 'f']]);
  });
});
