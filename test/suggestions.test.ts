import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { alwaysOptions } from '../src/daemon/suggestions.ts';

// The "always" choices of a permission dialog, as the box offers them.

describe('always choices', () => {
  it('as Claude Code 2.1.322 sends them for a write in the folder: a folder to add, a mode to switch to', () => {
    const options = alwaysOptions([
      { type: 'addDirectories', directories: [`${homedir()}/progetti/app`], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(options.map(({ label, where }) => ({ label, where }))).toEqual([
      { label: 'Allow and add the folder ~/progetti/app', where: 'only in this session' },
      { label: 'Allow and switch to the mode “accept edits”', where: 'only in this session' },
    ]);
  });

  it('a rule for a command, kept in the project', () => {
    const update = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
    const [option] = alwaysOptions([update]);
    expect(option).toEqual({ update, label: 'Always allow Bash(npm test:*)', where: 'in this project, only for you' });
  });

  it('leaves out what goes beyond the project or turns every dialog off, and what it cannot read', () => {
    expect(
      alwaysOptions([
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
        { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
        { type: 'addRules', rules: [{}], behavior: 'allow', destination: 'session' },
        'nope',
        null,
      ]),
    ).toEqual([]);
    expect(alwaysOptions(undefined)).toEqual([]);
  });
});
