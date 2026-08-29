/** Builds the lightweight graph index: nodes, directed edges, transitive depth. */
import path from 'node:path';
import type { StoryGraph, StoryNode, StoryEdge, OwnerLease } from '../data.js';
import { TERMINAL_PHASES } from '../machine.js';
import { getScan, readArtifact } from '../store/fn.js';

const RE_ID = /\bB-[0-9a-f]{4}\b/g;

interface IndexJson {
  title?: string; phase?: string; type?: string; priority?: string;
  createdAt?: string; endedAt?: string; startedAt?: string;
  depends?: string[]; riskSignals?: { category?: string }[];
}

/** Per-story cache: signature -> the expensive per-story facts derived from disk. */
interface StoryFacts {
  readonly idx: IndexJson;
  readonly refBlob: string;
  readonly nItems: number; readonly nDone: number; readonly nEv: number;
  readonly nFind: number; readonly openFind: number;
  readonly totalMs: number | null;
}
const factsCache = new Map<string, { sig: string; facts: StoryFacts }>();

export function buildGraph(root: string): StoryGraph {
  const scanned = getScan(root);
  const S = scanned.resolved;
  const ids = Object.keys(S.primary);
  const facts: Record<string, StoryFacts> = {};
  for (const sid of ids) {
    const sig = scanned.perStory.get(sid) ?? '';
    const hit = factsCache.get(sid);
    if (hit && hit.sig === sig) { facts[sid] = hit.facts; continue }
    const idxJson = readArtifact<IndexJson>(S, sid, 'index.json') ?? {};
    const chk = readArtifact<{ items?: { status?: string; verificationEvidence?: unknown[] }[] }>(S, sid, 'checklist.json') ?? {};
    const items = chk.items ?? [];
    const rawF = readArtifact<unknown>(S, sid, 'findings.json');
    const found = (Array.isArray(rawF) ? rawF : (rawF as { findings?: unknown[] } | null)?.findings ?? []) as { status?: string }[];
    const sm = readArtifact<{ totalDurationMs?: number }>(S, sid, 'summary.json') ?? {};
    let refBlob = JSON.stringify(idxJson);
    for (const f of ['understanding.json', 'decision.json']) refBlob += JSON.stringify(readArtifact(S, sid, f) ?? '');
    for (const f of ['background.md', 'plan.md']) refBlob += readArtifact<string>(S, sid, f, 'text') ?? '';
    const built: StoryFacts = {
      idx: idxJson, refBlob,
      nItems: items.length,
      nDone: items.filter(x => x.status === 'done').length,
      nEv: items.reduce((a, x) => a + ((x.verificationEvidence ?? []).length), 0),
      nFind: found.length,
      openFind: found.filter(x => x.status === 'open').length,
      totalMs: sm.totalDurationMs ?? null,
    };
    facts[sid] = built;
    factsCache.set(sid, { sig, facts: built });
  }
  const idx: Record<string, IndexJson> = {};
  for (const sid of ids) idx[sid] = facts[sid].idx;

  const edges: StoryEdge[] = [];
  const seen = new Set<string>();
  const add = (s: string, t: string, k: 'dep' | 'ref') => {
    const key = `${s}>${t}`;
    if (seen.has(key)) return;
    seen.add(key); edges.push({ s, t, k });
  };

  // 1. declared dependencies
  for (const sid of ids) for (const dep of idx[sid].depends ?? []) if (idx[dep]) add(sid, dep, 'dep');

  // 2. textual references. `depends` alone covers only ~35 of 367 stories, which would
  //    leave the graph almost entirely disconnected; prose references recover the rest.
  //    Direction is chronological: a newer story referencing an older one builds on it.
  for (const sid of ids) {
    const blob = facts[sid].refBlob;
    const created = idx[sid].createdAt ?? '';
    for (const m of new Set(blob.match(RE_ID) ?? []))
      if (m !== sid && idx[m] && created > (idx[m].createdAt ?? '')) add(sid, m, 'ref');
  }

  const inbound: Record<string, string[]> = {};
  const outdeg: Record<string, number> = {};
  for (const sid of ids) { inbound[sid] = []; outdeg[sid] = 0 }
  for (const e of edges) { inbound[e.t]?.push(e.s); outdeg[e.s] = (outdeg[e.s] ?? 0) + 1 }

  // transitive dependents (BFS over inbound edges) -> node size
  const depth: Record<string, number> = {};
  for (const sid of ids) {
    const reach = new Set([sid]);
    const q = [sid];
    while (q.length) {
      const n = q.shift()!;
      for (const p of inbound[n] ?? []) if (!reach.has(p)) { reach.add(p); q.push(p) }
    }
    depth[sid] = reach.size - 1;
  }

  const terminal = new Set<string>(TERMINAL_PHASES);
  const stories: StoryNode[] = ids.map(sid => {
    const i = idx[sid];
    const ft = facts[sid]!;
    // The lease is tiny and changes on a heartbeat cadence, so it stays a live read;
    // everything else comes from the per-story cache keyed on that story's signature.
    const lease = readArtifact<OwnerLease>(S, sid, 'owner-lease.json');
    return {
      id: sid,
      title: i.title ?? '',
      phase: i.phase ?? 'UNKNOWN',
      type: i.type, pri: i.priority,
      created: i.createdAt ?? '',
      ended: i.endedAt ?? '',
      depth: depth[sid] ?? 0,
      indeg: (inbound[sid] ?? []).length,
      outdeg: outdeg[sid] ?? 0,
      nItems: ft.nItems,
      nDone: ft.nDone,
      nEv: ft.nEv,
      nFind: ft.nFind,
      openFind: ft.openFind,
      inFlight: !terminal.has(i.phase ?? ''),
      wt: S.wt[sid] ? path.relative(root, S.wt[sid]) : null,
      lease: lease ? { beat: lease.heartbeatAt, cmd: lease.command } : null,
      totalMs: ft.totalMs,
      risk: (i.riskSignals ?? []).map(r => r.category ?? '').filter(Boolean),
    };
  });

  return { stories, edges, generatedAt: new Date().toISOString() };
}
