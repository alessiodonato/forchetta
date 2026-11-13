// node:os for the demo: a home folder of its own, the same for every visitor.
export const HOME = '/Users/you';
export const homedir = (): string => HOME;
export const tmpdir = (): string => '/tmp';
export const platform = (): string => 'darwin';
export const userInfo = (): { username: string; homedir: string; shell: string } => ({ username: 'you', homedir: HOME, shell: '/bin/zsh' });
export const hostname = (): string => 'demo';
export const EOL = '\n';
export default { homedir, tmpdir, platform, userInfo, hostname, EOL };
