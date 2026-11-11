import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { activeTask, clip, firstQuestion, opening, plainText, toolLabel } from '../src/daemon/labels.ts';

describe('toolLabel', () => {
  it('names the tool and its main argument', () => {
    expect(toolLabel('Bash', { command: 'npm test\nnpm run lint' })).toEqual({ label: 'Bash npm test', family: 'shell' });
    expect(toolLabel('Edit', { file_path: '/repo/src/api.ts' }, '/repo')).toEqual({ label: 'Edit src/api.ts', family: 'edit' });
    expect(toolLabel('Read', { file_path: `${homedir()}/notes.md` }, '/repo').label).toBe('Read ~/notes.md');
    expect(toolLabel('Grep', { pattern: 'TODO' }).label).toBe('Grep "TODO"');
    expect(toolLabel('WebFetch', { url: 'https://code.claude.com/docs/en/hooks?x=1' })).toEqual({ label: 'WebFetch code.claude.com/docs/en/hooks', family: 'web' });
    expect(toolLabel('Task', { description: 'Cerca i test', subagent_type: 'Explore' })).toEqual({ label: 'Task Cerca i test', family: 'agent' });
    expect(toolLabel('mcp__github__create_issue', {})).toEqual({ label: 'github · create_issue', family: 'other' });
    expect(toolLabel('Unknown', null)).toEqual({ label: 'Unknown', family: 'other' });
  });

  it('keeps labels short', () => {
    expect(toolLabel('Bash', { command: 'x'.repeat(200) }).label.length).toBe(80);
  });
});

describe('summaries', () => {
  it('reads the task in progress', () => {
    const todos = [
      { content: 'Scrivere i test', status: 'completed', activeForm: 'Scrivendo i test' },
      { content: 'Collegare il daemon', status: 'in_progress', activeForm: 'Collegando il daemon' },
    ];
    expect(activeTask('TodoWrite', { todos })).toBe('Collegando il daemon');
    expect(activeTask('TodoWrite', { todos: [] })).toBeUndefined();
    expect(activeTask('Bash', { command: 'ls' })).toBeUndefined();
  });

  it('reads the first question', () => {
    expect(firstQuestion({ questions: [{ question: 'Quale stack?' }] })).toBe('Quale stack?');
    expect(firstQuestion({})).toBeUndefined();
  });

  it('turns markdown into one line of text', () => {
    expect(plainText('## Fatto\n\n- **uno** e `due`\n- [link](http://x)\n\n```ts\ncode\n```\nfine')).toBe('Fatto uno e due link fine');
  });

  it('takes whole sentences until the opening says something', () => {
    expect(opening('Fatto. Ho aggiunto il campo `contextWindow` allo stato. Poi altro.')).toBe('Fatto. Ho aggiunto il campo contextWindow allo stato.');
    expect(opening('Una frase abbastanza lunga da bastare da sola, davvero. Seconda.')).toBe('Una frase abbastanza lunga da bastare da sola, davvero.');
    expect(opening('x'.repeat(300)).length).toBe(140);
    expect(opening('Ho modificato src/api.ts e il resto va.')).toBe('Ho modificato src/api.ts e il resto va.');
  });

  it('clips to one line', () => {
    expect(clip('  a\n b  ', 10)).toBe('a b');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});
