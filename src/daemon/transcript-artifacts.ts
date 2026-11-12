import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { type ArtifactLink, artifactOf } from '../shared/artifacts.ts';

// The artifacts a session published or opened before Forchetta saw it (or before Forchetta knew artifacts): read
// once from its transcript. Claude Code writes each tool call in an assistant line ({ type: 'tool_use', id, name,
// input }) and its result in a later user line ({ type: 'tool_result', tool_use_id } and, at the top,
// `toolUseResult`: for the Artifact tool { url, title, … }). A transcript can be tens of MB: it is read line by line,
// and only the lines that can matter are parsed.

type Entry = { timestamp?: unknown; toolUseResult?: unknown; message?: { content?: unknown } };
type Part = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown };

const partsOf = (entry: Entry): Part[] => (Array.isArray(entry.message?.content) ? (entry.message.content as Part[]) : []);

export async function artifactsInTranscript(file: string): Promise<ArtifactLink[]> {
  const inputs = new Map<string, unknown>();
  const found: ArtifactLink[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const call = line.includes('"name":"Artifact"');
    const result = inputs.size > 0 && line.includes('"toolUseResult"') && line.includes('claude.ai/');
    if (!call && !result) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    for (const part of partsOf(entry)) {
      if (part.type === 'tool_use' && part.name === 'Artifact' && typeof part.id === 'string') inputs.set(part.id, part.input);
      if (part.type === 'tool_result' && typeof part.tool_use_id === 'string' && inputs.has(part.tool_use_id)) {
        const link = artifactOf('Artifact', inputs.get(part.tool_use_id), entry.toolUseResult);
        const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        if (link) found.push({ ...link, at: Number.isFinite(at) ? at : 0 });
      }
    }
  }
  return found;
}
