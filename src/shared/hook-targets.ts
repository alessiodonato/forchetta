import { existsSync } from 'node:fs';
import { type Config, resolveTool } from './config.ts';
import { join, WINDOWS } from './fspath.ts';
import { paths, stablePath } from './paths.ts';
import { type HookTargets, isOurHook, windowsStatusCommand } from './settings.ts';
import { pathDirs } from './windows.ts';

// What the hooks of Forchetta run on this computer, for the settings of Claude Code (shared/settings.ts).

export function hookTargets(config: Config): HookTargets {
  return {
    port: config.port,
    hookScript: paths.hookScript,
    permissionScript: paths.permissionScript,
    guardScript: paths.guardScript,
    ...(WINDOWS ? { windows: { node: stablePath(resolveTool('node', config)), hookJs: paths.hookJs } } : {}),
  };
}

/** The node the hooks of Forchetta in these settings run on, on Windows. */
export function nodeOfHooks(settings: Record<string, unknown>): string | undefined {
  const groups = settings.hooks && typeof settings.hooks === 'object' ? Object.values(settings.hooks as Record<string, unknown>).flat() : [];
  for (const group of groups) {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    for (const hook of Array.isArray(hooks) ? (hooks as Record<string, unknown>[]) : []) {
      if (hook && typeof hook === 'object' && Array.isArray(hook.args) && typeof hook.command === 'string' && isOurHook(hook)) return hook.command;
    }
  }
  return undefined;
}

/** The status line of Forchetta, and why there cannot be one (Windows: a space in a path, and no command in the PATH). */
export function statusTargets(config: Config): { port: number; statusScript: string; command?: string } | undefined {
  const targets = { port: config.port, statusScript: paths.statusScript };
  if (!WINDOWS) return targets;
  const inPath = pathDirs().some((dir) => existsSync(join(dir, 'forchetta-statusline.cmd')));
  const command = windowsStatusCommand({ port: config.port, node: stablePath(resolveTool('node', config)), hookJs: paths.hookJs }, inPath);
  return command ? { ...targets, command } : undefined;
}
