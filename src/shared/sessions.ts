import { type Config, resolveTool } from './config.ts';
import { WINDOWS } from './fspath.ts';
import { HostSessions } from './host-sessions.ts';
import { paths } from './paths.ts';
import { Tmux } from './tmux.ts';

// Where the sessions run: in the private tmux server of Forchetta; on Windows, in their hosts.

export const sessionsOf = (config: Config): Tmux => (WINDOWS ? new HostSessions({ node: resolveTool('node', config) }) : new Tmux(resolveTool('tmux', config), paths.tmuxSocket, paths.tmuxConf));
