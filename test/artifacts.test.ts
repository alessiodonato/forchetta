import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slimPayload } from '../src/daemon/server.ts';
import { artifactsInTranscript } from '../src/daemon/transcript-artifacts.ts';
import { addArtifact, artifactOf, linksIn, MAX_ARTIFACTS, mergeArtifacts, openableUrl } from '../src/shared/artifacts.ts';
import { artifactName, artifactsLabel, menuPlace } from '../src/ui/Artifacts.tsx';
import { tempDir } from './helpers.ts';

const temp = tempDir('artifacts');
afterAll(() => temp.cleanup());

// The artifacts of claude.ai in the box of a session: what the Artifact tool of Claude Code published or opened,
// from its PostToolUse, and the links Forchetta may open in the browser.

const URL_A = 'https://claude.ai/artifact/J3SWYv5i35bkxCN6hYJzQx';
const URL_B = 'https://claude.ai/code/artifact/8a0290c7-3961-4c27-84c5-bd76d5f75dc9';

describe('what the Artifact tool published or opened', () => {
  it('a publish: its link and title, from the object of the response', () => {
    const response = { url: URL_A, path: '/tmp/x/kit.html', artifact_id: '8a02', title: 'Forchetta launch kit', updated: false, owned: true, version: '1794420020-3aac' };
    expect(artifactOf('Artifact', { file_path: '/tmp/x/kit.html', icon: 'megaphone' }, response)).toEqual({ url: URL_A, title: 'Forchetta launch kit' });
    expect(artifactOf('Artifact', { action: 'publish', file_path: '/tmp/x/kit.html' }, { url: URL_B })).toEqual({ url: URL_B });
  });

  it('an open: marked as opened', () => {
    expect(artifactOf('Artifact', { action: 'open', url: URL_A }, { opened: true, url: URL_A, title: 'Kit' })).toEqual({ url: URL_A, title: 'Kit', opened: true });
  });

  it('with only the text of the result, the link is read from it', () => {
    const text = `Published /tmp/x/kit.html at ${URL_A} (Version 2, version id 1794433925-0a8a)\n\nLive subscription: …`;
    expect(artifactOf('Artifact', { file_path: '/tmp/x/kit.html' }, text)).toEqual({ url: URL_A });
    expect(artifactOf('Artifact', { action: 'open', url: URL_A }, [{ type: 'text', text: `Opened the Artifact at ${URL_A} for the user.` }])).toEqual({ url: URL_A, opened: true });
  });

  it('nothing for a read, a list, a quickstart, an asset, another tool or a link that is not an artifact', () => {
    expect(artifactOf('Artifact', { action: 'read', url: URL_A }, { url: URL_A, title: 'x' })).toBeUndefined();
    expect(artifactOf('Artifact', { action: 'list' }, `… ${URL_A} …`)).toBeUndefined();
    expect(artifactOf('Artifact', { action: 'quickstart', intent: 'other' }, { quickstart: { types: [{ type_url: URL_A }] } })).toBeUndefined();
    expect(artifactOf('Artifact', { url: URL_A, file_path: '/tmp/a.png', asset: true }, { url: URL_A })).toBeUndefined();
    expect(artifactOf('WebFetch', { url: URL_A }, { url: URL_A })).toBeUndefined();
    expect(artifactOf('Artifact', {}, { url: 'https://evil.example/artifact/J3SWYv5i35' })).toBeUndefined();
    expect(artifactOf('Artifact', {}, { url: `${URL_A}?x=1` })).toBeUndefined();
  });

  it('a long title is cut short, an empty one dropped', () => {
    expect(artifactOf('Artifact', {}, { url: URL_A, title: `  ${'t'.repeat(200)}  ` })?.title).toHaveLength(120);
    expect(artifactOf('Artifact', {}, { url: URL_A, title: '   ' })).toEqual({ url: URL_A });
  });

  it('the hook keeps only the link and the title, never the rest of the response', () => {
    const payload = slimPayload({
      hook_event_name: 'PostToolUse',
      session_id: 's-1',
      tool_name: 'Artifact',
      tool_input: { file_path: '/tmp/x/kit.html' },
      tool_response: { url: URL_A, title: 'Kit', path: '/tmp/x/kit.html', secret: 'x' },
    });
    expect(payload?.artifact).toEqual({ url: URL_A, title: 'Kit' });
    expect(payload?.tool_response).toBeUndefined();
    expect(slimPayload({ hook_event_name: 'PreToolUse', session_id: 's-1', tool_name: 'Artifact', tool_response: { url: URL_A } })?.artifact).toBeUndefined();
  });
});

describe('the list of a box', () => {
  it('the newest first, the same link once, a publish wins over an open', () => {
    let list = addArtifact(undefined, { url: URL_A, title: 'Kit', at: 1, opened: true });
    list = addArtifact(list, { url: URL_B, at: 2 });
    expect(list.map((item) => item.url)).toEqual([URL_B, URL_A]);
    list = addArtifact(list, { url: URL_A, at: 3 });
    expect(list).toEqual([{ url: URL_A, title: 'Kit', at: 3 }, { url: URL_B, at: 2 }]);
    // Opened again after it was published: still one this session published.
    expect(addArtifact(list, { url: URL_A, at: 4, opened: true })[0]).toEqual({ url: URL_A, title: 'Kit', at: 4 });
  });

  it('keeps at most twenty', () => {
    let list = addArtifact(undefined, { url: URL_A, at: 0 });
    for (let i = 1; i <= 30; i++) list = addArtifact(list, { url: `https://claude.ai/artifact/abcdef${i}`, at: i });
    expect(list).toHaveLength(MAX_ARTIFACTS);
    expect(list[0]!.url).toBe('https://claude.ai/artifact/abcdef30');
  });

  it('the list opens where there is room, on the side of its button', () => {
    const view = { width: 1280, height: 800 };
    // A box at the top left: under the button, from its left edge.
    expect(menuPlace({ top: 210, bottom: 230, left: 100, right: 180 }, view)).toEqual({ top: 236, left: 100 });
    // The header of a pane on the right, low in the window: over the button, from its right edge.
    expect(menuPlace({ top: 700, bottom: 720, left: 1100, right: 1180 }, view)).toEqual({ bottom: 106, right: 100 });
    // Never against the edge of the window.
    expect(menuPlace({ top: 10, bottom: 30, left: 2, right: 60 }, view)).toEqual({ top: 36, left: 8 });
  });

  it('the button and the lines of the list', () => {
    expect(artifactsLabel(1)).toBe('1 artifact');
    expect(artifactsLabel(3)).toBe('3 artifacts');
    expect(artifactName({ url: URL_A, title: 'Kit', at: 0 })).toBe('Kit');
    expect(artifactName({ url: URL_A, at: 0 })).toBe('claude.ai/artifact/J3SWYv5i35bkxCN6hYJzQx');
  });
});

describe('the artifacts of a transcript', () => {
  it('the Artifact calls and their results, as Claude Code writes them; a read and other tools are left out', async () => {
    const line = (value: unknown) => JSON.stringify(value);
    const use = (id: string, name: string, input: unknown) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, at: string, toolUseResult: unknown) => line({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] }, toolUseResult });
    const file = join(temp.dir, 'session.jsonl');
    writeFileSync(
      file,
      [
        line({ type: 'user', message: { content: 'hello' } }),
        use('t1', 'Artifact', { file_path: '/tmp/a.html' }),
        result('t1', '2026-11-11T17:58:10.413Z', { url: URL_A, title: 'Kit', version: '1' }),
        use('t2', 'Artifact', { action: 'read', url: URL_B }),
        result('t2', '2026-11-11T18:00:00.000Z', { url: URL_B, title: 'Read only' }),
        use('t3', 'WebFetch', { url: URL_B }),
        result('t3', '2026-11-11T18:01:00.000Z', { url: URL_B }),
        'not json',
        use('t4', 'Artifact', { action: 'open', url: URL_A }),
        result('t4', '2026-11-11T18:05:00.000Z', { opened: true, url: URL_A, title: 'Kit' }),
      ].join('\n'),
    );
    const found = await artifactsInTranscript(file);
    expect(found).toEqual([
      { url: URL_A, title: 'Kit', at: Date.parse('2026-11-11T17:58:10.413Z') },
      { url: URL_A, title: 'Kit', opened: true, at: Date.parse('2026-11-11T18:05:00.000Z') },
    ]);
    // Published, then opened: one line, still published, with its last time.
    expect(mergeArtifacts(undefined, found)).toEqual([{ url: URL_A, title: 'Kit', at: Date.parse('2026-11-11T18:05:00.000Z') }]);
  });

  it('merged with what the hooks brought, by time', () => {
    const live = [{ url: URL_B, at: 50 }];
    expect(mergeArtifacts(live, [{ url: URL_A, at: 10 }]).map((item) => item.url)).toEqual([URL_B, URL_A]);
    expect(mergeArtifacts(live, [{ url: URL_A, at: 90 }]).map((item) => item.url)).toEqual([URL_A, URL_B]);
  });
});

describe('the links Forchetta opens in the browser', () => {
  it('https anywhere, http only on this Mac, nothing else', () => {
    expect(openableUrl(URL_A)).toBe(true);
    expect(openableUrl('https://github.com/x/y/pull/3')).toBe(true);
    expect(openableUrl('http://localhost:5173/')).toBe(true);
    expect(openableUrl('http://127.0.0.1:47821/#token=x')).toBe(true);
    expect(openableUrl('http://example.com')).toBe(false);
    expect(openableUrl('file:///etc/passwd')).toBe(false);
    expect(openableUrl('javascript:alert(1)')).toBe(false);
    expect(openableUrl('https://user:pass@example.com')).toBe(false);
    expect(openableUrl('not a url')).toBe(false);
  });

  it('the links in a line of a terminal, without the punctuation around them', () => {
    expect(linksIn(`⏺ Published at ${URL_A}. Open it.`)).toEqual([{ url: URL_A, index: 15 }]);
    expect(linksIn('see (https://en.wikipedia.org/wiki/Fork_(software)) and http://localhost:3000/a, done').map((link) => link.url)).toEqual([
      'https://en.wikipedia.org/wiki/Fork_(software)',
      'http://localhost:3000/a',
    ]);
    expect(linksIn('http://example.com is not opened, file:///x neither')).toEqual([]);
  });
});
