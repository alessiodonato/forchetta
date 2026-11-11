import type { ToolFamily } from '../shared/agent.ts';

// Six small glyphs, one per kind of tool: they say which tool runs, nothing else.

const PATHS: Record<ToolFamily, string> = {
  edit: 'M3.2 12.8l.6-2.6 7.1-7.1 2 2-7.1 7.1-2.6.6z',
  shell: 'M3 4.5l3.5 3.5L3 11.5M8.5 11.5H13',
  read: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3L13.5 13.5',
  web: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z',
  agent: 'M4.5 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11.5 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6.5 8h3',
  other: 'M5.5 5.5h5v5h-5z',
};

export function ToolIcon({ family }: { family: ToolFamily }) {
  return (
    <svg class="glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={PATHS[family]} />
    </svg>
  );
}

export function Check() {
  return (
    <svg class="check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3.5 8.5l2.8 2.8L12.5 5" />
    </svg>
  );
}
