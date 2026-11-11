import { loadConfig, resolveTool } from '../shared/config.ts';
import { api, ensureDaemon, readDaemonInfo, runningDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { paths } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { closest, code, commandHelp, mainHelp, suggestCommand } from './help.ts';
import { hooksCommand } from './hooks.ts';
import { ago, listSessions } from './ls.ts';
import { type RunIO, runClaude } from './run.ts';
import { defaultAppDir, setupCommand } from './setup.ts';
import { pairs, styleFor, tildify } from './style.ts';

const io: RunIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  style: styleFor(process.stdout),
  errorStyle: styleFor(process.stderr),
};

const wantsHelp = (args: readonly string[]): boolean => args.includes('--help') || args.includes('-h');

/** Refuses an option the command does not know, instead of going on without it. */
function checkOptions(command: string, args: readonly string[], known: readonly string[]): void {
  for (const arg of args) {
    if (!arg.startsWith('-') || known.includes(arg)) continue;
    const near = closest(arg, known);
    throw new UserError(`unknown option ${arg} for ${command}`, near ? `did you mean \`${near}\`?` : `see \`forchetta ${command} --help\``);
  }
}

async function daemonCommand(action: string | undefined): Promise<number> {
  const s = io.style;
  switch (action) {
    case 'start': {
      const info = await ensureDaemon(resolveTool('node', loadConfig()));
      if (!info) throw new UserError('the daemon did not start', `see its log: ${tildify(paths.log)}`);
      io.stdout(`${s.mark('✓', 'green', `Daemon running ${s.dim(`· pid ${info.pid} · port ${info.port}`)}`)}\n`);
      return 0;
    }
    case 'stop': {
      const info = await runningDaemon();
      if (!info) {
        io.stdout(`${s.mark('○', 'gray', 'The daemon is not running.')}\n`);
        return 0;
      }
      await api(info, 'POST', '/api/shutdown');
      for (let attempt = 0; attempt < 30 && (await runningDaemon()); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      io.stdout(`${s.mark('✓', 'green', `Daemon stopped. ${s.dim('The Claude and tmux sessions go on.')}`)}\n`);
      return 0;
    }
    case 'status': {
      const info = await runningDaemon();
      if (!info) {
        const stale = readDaemonInfo() ? ` ${s.dim(`(${tildify(paths.daemonInfo)} belongs to a stopped daemon)`)}` : '';
        io.stdout(`${s.mark('○', 'gray', `The daemon is not running.${stale}`)}\n  ${code('Start it with `forchetta daemon start`, or open the app.', s)}\n`);
        return 1;
      }
      const health = await api<{ agents: number; startedAt: number; version: string }>(info, 'GET', '/api/health');
      const rows: [string, string][] = [
        ['version', health.version],
        ['pid', String(info.pid)],
        ['port', String(info.port)],
        ['uptime', ago(Date.now() - health.startedAt)],
        ['sessions', String(health.agents)],
      ];
      io.stdout(`${s.mark('●', 'green', s.bold('Daemon running'))}\n${pairs(rows, s)}\n`);
      if (health.version !== VERSION) {
        io.stdout(
          `\n${s.mark('▲', 'amber', `This forchetta is ${VERSION}, the daemon ${health.version}.`)}\n  ${code('To restart it on the new version: `forchetta daemon stop && forchetta daemon start`', s)}\n`,
        );
      }
      return 0;
    }
    case undefined:
      throw new UserError('daemon needs an action: start, stop or status', 'see `forchetta daemon --help`');
    default: {
      const near = closest(action, ['start', 'stop', 'status']);
      throw new UserError(`unknown action "${action}" for daemon`, near ? `did you mean \`forchetta daemon ${near}\`?` : 'see `forchetta daemon --help`');
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // `forchetta run claude --help` is the help of claude: only `forchetta run --help` is the one of run.
  const help = command === 'run' ? rest[0] === '--help' || rest[0] === '-h' : wantsHelp(rest);
  if (help && command) {
    const text = commandHelp(command, io.style);
    if (text) {
      io.stdout(text);
      return 0;
    }
  }
  switch (command) {
    case 'run':
      return runClaude(rest, io);
    case 'ls':
      checkOptions('ls', rest, ['--json']);
      return listSessions(io, { json: rest.includes('--json') });
    case 'daemon':
      return daemonCommand(rest[0]);
    case 'setup': {
      const args = rest.flatMap((arg) => (arg.startsWith('--app-dir=') ? ['--app-dir', arg.slice('--app-dir='.length)] : [arg]));
      const at = args.indexOf('--app-dir');
      const appDir = at >= 0 ? args[at + 1] : defaultAppDir();
      if (!appDir) throw new UserError('--app-dir needs a folder', 'for example `forchetta setup --app-dir /Applications`');
      checkOptions(
        'setup',
        args.filter((_, index) => at < 0 || index !== at + 1),
        ['--yes', '--force', '--diff', '--app-dir'],
      );
      return setupCommand({ yes: args.includes('--yes'), force: args.includes('--force'), diff: args.includes('--diff'), appDir }, io);
    }
    case 'hooks': {
      const action = rest[0];
      if (action !== 'install' && action !== 'uninstall') {
        const near = action ? closest(action, ['install', 'uninstall']) : undefined;
        throw new UserError(
          action ? `unknown action "${action}" for hooks` : 'hooks needs an action: install or uninstall',
          near ? `did you mean \`forchetta hooks ${near}\`?` : 'see `forchetta hooks --help`',
        );
      }
      checkOptions('hooks', rest.slice(1), ['--yes', '--diff']);
      return hooksCommand(action, { yes: rest.includes('--yes'), diff: rest.includes('--diff') }, io);
    }
    case undefined:
    case 'help':
    case '-h':
    case '--help': {
      const topic = command === 'help' ? rest[0] : undefined;
      const text = topic ? commandHelp(topic, io.style) : mainHelp(io.style);
      if (!text) throw new UserError(`no command is called "${topic}"`, 'see `forchetta --help`');
      io.stdout(text);
      return 0;
    }
    case '--version':
    case '-V':
      io.stdout(`${VERSION}\n`);
      return 0;
    default: {
      const near = command.startsWith('-') ? undefined : suggestCommand(command);
      throw new UserError(
        `unknown ${command.startsWith('-') ? 'option' : 'command'} "${command}"`,
        near ? `did you mean \`${near}\`?` : 'see `forchetta --help` for the commands',
      );
    }
  }
}

function printError(error: unknown): void {
  const s = io.errorStyle;
  const head = s.color ? `${s.red('✗')} ` : 'forchetta: ';
  if (error instanceof UserError) {
    const hint = error.hint ? `\n  ${s.color ? `${s.dim('→')} ` : ''}${code(error.hint, s)}` : '';
    io.stderr(`${head}${code(error.message, s)}${hint}\n`);
  } else {
    io.stderr(`${head}${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
}

main(process.argv.slice(2)).then(
  (status) => process.exit(status),
  (error: unknown) => {
    printError(error);
    process.exit(1);
  },
);
