import { loadConfig, resolveTool } from '../shared/config.ts';
import { api, ensureDaemon, readDaemonInfo, runningDaemon } from '../shared/daemon-client.ts';
import { UserError } from '../shared/errors.ts';
import { VERSION } from '../shared/version.ts';
import { hooksCommand } from './hooks.ts';
import { ago, listSessions } from './ls.ts';
import { type RunIO, runClaude } from './run.ts';

const USAGE = `forchetta ${VERSION}: centro di controllo per sessioni Claude Code parallele

Uso:
  forchetta run claude [argomenti]    avvia Claude Code in tmux, visibile e comandabile da Forchetta
  forchetta ls                        elenca le sessioni Claude Code e il loro stato
  forchetta daemon start|stop|status  gestisce il daemon locale (le sessioni non si fermano mai)
  forchetta hooks install|uninstall   aggiunge o toglie gli hook in ~/.claude/settings.json
                                      (mostra il diff e chiede prima; --yes per non chiedere)
`;

const io: RunIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

async function daemonCommand(action: string | undefined): Promise<number> {
  switch (action) {
    case 'start': {
      const info = await ensureDaemon(resolveTool('node', loadConfig()));
      if (!info) throw new UserError('il daemon non è partito: guarda var/daemon.log');
      io.stdout(`Daemon attivo (pid ${info.pid}, porta ${info.port}).\n`);
      return 0;
    }
    case 'stop': {
      const info = await runningDaemon();
      if (!info) {
        io.stdout('Il daemon non è attivo.\n');
        return 0;
      }
      await api(info, 'POST', '/api/shutdown');
      for (let attempt = 0; attempt < 30 && (await runningDaemon()); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      io.stdout('Daemon fermato. Le sessioni Claude e tmux restano attive.\n');
      return 0;
    }
    case 'status': {
      const info = await runningDaemon();
      if (!info) {
        io.stdout(readDaemonInfo() ? 'Il daemon non risponde (var/daemon.json è di un daemon fermato).\n' : 'Il daemon non è attivo.\n');
        return 1;
      }
      const health = await api<{ agents: number; startedAt: number; version: string }>(info, 'GET', '/api/health');
      io.stdout(`Daemon ${health.version} attivo: pid ${info.pid}, porta ${info.port}, da ${ago(Date.now() - health.startedAt)}, ${health.agents} sessioni note.\n`);
      return 0;
    }
    default:
      throw new UserError('uso: forchetta daemon start|stop|status');
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
    case 'hooks': {
      const action = rest[0];
      if (action !== 'install' && action !== 'uninstall') throw new UserError('uso: forchetta hooks install|uninstall [--yes]');
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
      throw new UserError(`comando sconosciuto: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(error instanceof UserError ? `forchetta: ${error.message}\n` : `forchetta: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
