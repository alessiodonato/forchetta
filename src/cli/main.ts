import { loadConfig, resolveTool } from '../shared/config.ts';
import { api, ensureDaemon, readDaemonInfo, runningDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { paths } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { hooksCommand } from './hooks.ts';
import { ago, listSessions } from './ls.ts';
import { type RunIO, runClaude } from './run.ts';
import { defaultAppDir, setupCommand } from './setup.ts';

const USAGE = `forchetta ${VERSION}: control center for parallel Claude Code sessions

Usage:
  forchetta setup                     gets Forchetta ready: builds the app in ~/Applications and installs the hooks
                                      (--yes for no question, --force to build again, --app-dir <folder>)
  forchetta run claude [arguments]    starts Claude Code in tmux, where Forchetta shows it and sends it commands
  forchetta ls                        lists the Claude Code sessions and their state
  forchetta daemon start|stop|status  manages the local daemon (sessions never stop with it)
  forchetta hooks install|uninstall   adds or removes the hooks in ~/.claude/settings.json
                                      (shows the diff and asks first; --yes for no question)
`;

const io: RunIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

async function daemonCommand(action: string | undefined): Promise<number> {
  switch (action) {
    case 'start': {
      const info = await ensureDaemon(resolveTool('node', loadConfig()));
      if (!info) throw new UserError(`the daemon did not start: see ${paths.log}`);
      io.stdout(`Daemon running (pid ${info.pid}, port ${info.port}).\n`);
      return 0;
    }
    case 'stop': {
      const info = await runningDaemon();
      if (!info) {
        io.stdout('The daemon is not running.\n');
        return 0;
      }
      await api(info, 'POST', '/api/shutdown');
      for (let attempt = 0; attempt < 30 && (await runningDaemon()); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      io.stdout('Daemon stopped. The Claude and tmux sessions go on.\n');
      return 0;
    }
    case 'status': {
      const info = await runningDaemon();
      if (!info) {
        io.stdout(readDaemonInfo() ? `The daemon does not answer (${paths.daemonInfo} belongs to a stopped daemon).\n` : 'The daemon is not running.\n');
        return 1;
      }
      const health = await api<{ agents: number; startedAt: number; version: string }>(info, 'GET', '/api/health');
      io.stdout(`Daemon ${health.version} running: pid ${info.pid}, port ${info.port}, for ${ago(Date.now() - health.startedAt)}, ${health.agents} sessions known.\n`);
      return 0;
    }
    default:
      throw new UserError('usage: forchetta daemon start|stop|status');
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return runClaude(rest, io);
    case 'ls':
      return listSessions(io);
    case 'daemon':
      return daemonCommand(rest[0]);
    case 'setup': {
      const at = rest.indexOf('--app-dir');
      const appDir = at >= 0 ? rest[at + 1] : defaultAppDir();
      if (!appDir) throw new UserError('usage: forchetta setup [--yes] [--force] [--app-dir <folder>]');
      return setupCommand({ yes: rest.includes('--yes'), force: rest.includes('--force'), appDir }, io);
    }
    case 'hooks': {
      const action = rest[0];
      if (action !== 'install' && action !== 'uninstall') throw new UserError('usage: forchetta hooks install|uninstall [--yes]');
      return hooksCommand(action, { yes: rest.includes('--yes') }, io);
    }
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      io.stdout(USAGE);
      return 0;
    case '--version':
    case '-V':
      io.stdout(`${VERSION}\n`);
      return 0;
    default:
      throw new UserError(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(error instanceof UserError ? `forchetta: ${error.message}\n` : `forchetta: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
