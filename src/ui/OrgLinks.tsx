import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CrewSummary } from '../shared/crew.ts';
import { type ArrivalKind, type Arrival, arrivalsBetween, type Box, FLASH_MS, leadAgent, linkPath, linkStates, RANK, type Snapshot, snapshotOf } from './org-lines.ts';

// The lines of a team of agents in the org chart: one to each member from the one it reports to (the lead, or
// another member), drawn over the group. A line says what goes on between the two: a request the member works on
// (orange) or that waits in its queue (orange, dashed), an answer on its way back up (green), a question going up
// (amber). When something arrives, a request at the member, an answer or a question at the one above, its line
// flashes twice and a dot runs along it, the way it went. The colors stay still: only an arrival moves, for about
// a second.

interface Geometry {
  width: number;
  height: number;
  paths: [string, string][];
}

/**
 * "Riduci movimento" on, or the window hidden: nothing flashes. Read from the attributes motion.ts sets on <html>,
 * so that this module (and the chart, and their tests) does not need the media queries of a page.
 */
const still = (): boolean => document.documentElement.hasAttribute('data-reduced-motion') || document.documentElement.hasAttribute('data-hidden');

/** A dot that runs along a line once, from the lead or towards it. */
function Runner({ path, kind }: { path: string; kind: ArrivalKind }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  // The path goes in by hand (the types of Preact do not know it). A SMIL animation added to a page that is already
  // running would start at the time of the page: start it now.
  useLayoutEffect(() => {
    motion.current?.setAttribute('path', path);
    motion.current?.beginElement();
  }, []);
  const back = kind !== 'request';
  return (
    <circle r="3.5" class="org-runner">
      <animateMotion ref={motion} begin="indefinite" dur="0.9s" fill="freeze" keyPoints={back ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
    </circle>
  );
}

/** The lines of one team, over its group of the chart (the parent element). */
export function OrgLinks({ crew }: { crew: CrewSummary }) {
  const svg = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState<Geometry | undefined>(undefined);
  const drawn = useRef('');
  const lead = leadAgent(crew);
  const recipients = crew.recipients ?? [];
  const agentOf = new Map(recipients.map((recipient) => [recipient.name, recipient.agentId]));
  // Each member and the session of the one it reports to; none: the lead.
  const members = recipients
    .filter((recipient) => !recipient.lead && recipient.agentId)
    .map((recipient) => ({ id: recipient.agentId!, above: recipient.reportsTo !== undefined ? agentOf.get(recipient.reportsTo) : undefined }));

  const measure = (): void => {
    const group = svg.current?.parentElement;
    if (!group) return;
    const base = group.getBoundingClientRect();
    const boxOf = (element: Element | null): Box | undefined => {
      if (!element) return undefined;
      const rect = element.getBoundingClientRect();
      return { left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height };
    };
    const leadBox = boxOf(lead ? group.querySelector(`.org-leads [data-id="${lead}"]`) : group.querySelector('.org-you'));
    const memberBox = (id: string): Box | undefined => boxOf(group.querySelector(`.org-members [data-id="${id}"]`));
    // In a tree, the row of the brothers of a member: its node's parent. A member that wraps is reached along its left.
    const laneOf = (id: string): number | undefined => {
      const row = group.querySelector(`.org-members[data-tree] [data-id="${id}"]`)?.closest('.org-node')?.parentElement;
      return row ? row.getBoundingClientRect().left - base.left - 8 : undefined;
    };
    // A member whose one above has no box here hangs from the lead, as the chart puts it (Team.tsx).
    const boxes = members
      .map((member) => {
        const box = memberBox(member.id);
        const aboveBox = member.above !== undefined ? memberBox(member.above) : undefined;
        return box ? { id: member.id, box, from: aboveBox ?? leadBox, key: aboveBox ? member.above! : '', lane: laneOf(member.id) } : undefined;
      })
      .filter((item) => item !== undefined);
    // The first row of the members under the same one: where their lines turn.
    const firstTops = new Map<string, number>();
    for (const item of boxes) firstTops.set(item.key, Math.min(firstTops.get(item.key) ?? Number.POSITIVE_INFINITY, item.box.top));
    const next: Geometry = {
      width: Math.round(base.width),
      height: Math.round(base.height),
      paths: boxes.map((item) => [item.id, linkPath(item.from, item.box, firstTops.get(item.key)!, base.width, item.lane)]),
    };
    const key = JSON.stringify(next);
    if (key === drawn.current) return;
    drawn.current = key;
    setGeometry(boxes.length > 0 ? next : undefined);
  };

  // After every render (a box added, a line of text that wraps), when the group changes size, and once more when
  // the boxes that enter have settled. The observers call the measure of the last render: it knows the members.
  const latest = useRef(measure);
  latest.current = measure;
  useLayoutEffect(measure);
  useEffect(() => {
    const again = (): void => latest.current();
    const group = svg.current?.parentElement;
    const observer = group ? new ResizeObserver(again) : undefined;
    if (group) observer?.observe(group);
    window.addEventListener('resize', again);
    const settled = setTimeout(again, 500);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', again);
      clearTimeout(settled);
    };
  }, []);

  // What arrived since the last state of the team: each flashes for a moment, then goes.
  const known = useRef<Snapshot | undefined>(undefined);
  const [flashes, setFlashes] = useState<Arrival[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const arrived = still() ? [] : arrivalsBetween(known.current, crew);
    known.current = snapshotOf(crew);
    if (arrived.length === 0) return;
    setFlashes((current) => [...current, ...arrived]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFlashes((current) => current.filter((flash) => !arrived.includes(flash)));
    }, FLASH_MS);
    timers.current.add(timer);
  }, [crew]);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const states = linkStates(crew);
  const paths = new Map(geometry?.paths ?? []);
  // The quiet lines first, so that a line with something going on is drawn over a stretch it shares.
  const ordered = [...paths].sort(([a], [b]) => (states.has(a) ? RANK[states.get(a)!] : 0) - (states.has(b) ? RANK[states.get(b)!] : 0));
  return (
    <svg ref={svg} class="org-links" width={geometry?.width ?? 0} height={geometry?.height ?? 0} aria-hidden="true">
      {ordered.map(([id, path]) => (
        <path key={id} class="org-link" data-kind={states.get(id)} d={path} />
      ))}
      {flashes.map((flash) => {
        const path = paths.get(flash.agentId);
        if (!path) return null;
        return (
          <g key={flash.id} class="org-flash" data-kind={flash.kind}>
            <path d={path} />
            <Runner path={path} kind={flash.kind} />
          </g>
        );
      })}
    </svg>
  );
}
