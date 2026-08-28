/**
 * Self-audit: the invariants found by manual auditing, as an executable check.
 * Run against any Proof-or-Stop repo: `node dist/tasks/audit.js [root]`
 */
import path from 'node:path';
import { createApp } from '../core/app.js';
import { findRoot } from '../io/find-root.js';
import { PHASE_ORDER } from '../core/machine.js';

const fail: string[] = [];
const check = (ok: boolean, msg: string): void => { if (!ok) fail.push(msg) };

function main(): void {
  const probe = process.argv[2] ? { root: path.resolve(process.argv[2]) } : findRoot(process.cwd());
  if (!probe.root) { console.error('audit: no Proof-or-Stop root found'); process.exitCode = 1; return }
  const app = createApp({ root: probe.root });

  const g = app.getGraph();
  check(g.stories.length > 0, 'graph has no stories');
  check(g.edges.length > 0, 'graph has no edges');

  // 1. worktree precedence: a story with a worktree must not be stuck at INIT_CHECK
  //    with a near-empty event log (the bug that hid every in-flight story).
  for (const s of g.stories.filter(x => x.wt)) {
    check(!(s.phase === 'INIT_CHECK' && s.nItems === 0),
      `${s.id}: has worktree ${s.wt} but looks like a stale INIT_CHECK snapshot`);
  }

  // 2. every phase present is one the client can colour and filter
  const known = new Set<string>([...PHASE_ORDER, 'DISCARDED', 'META']);
  for (const ph of new Set(g.stories.map(s => s.phase)))
    check(known.has(ph), `phase ${ph} is not in PHASE_ORDER — client would hide its stories`);

  // 3. every story's detail loads, has files, and stays a sane size
  let heaviest = 0, heaviestId = '';
  for (const s of g.stories) {
    const d = app.getStory(s.id);
    check(!!d, `${s.id}: detail failed to load`);
    if (!d) continue;
    check(Object.keys(d.files).length > 0, `${s.id}: detail has no files`);
    const bytes = JSON.stringify(d).length;
    if (bytes > heaviest) { heaviest = bytes; heaviestId = s.id }
    check(bytes < 8 * 1024 * 1024, `${s.id}: detail is ${(bytes / 1048576).toFixed(1)}MB (>8MB)`);
  }

  // 4a. anchor id consistency: the lifecycle timeline links to finding cards by
  //     id, and this repo spells those ids BOTH ways -- bare ("F-205") and
  //     story-qualified ("B-137a:F-205"), sometimes differing between the event
  //     log and findings.json of the SAME story. Comparing raw strings made
  //     lifecycle -> Findings jumps silently scroll to the top. Assert here that
  //     bare-id normalisation actually reconciles the two sides.
  const bareId = (v: unknown): string => {
    const t = String(v); const i = t.lastIndexOf(':');
    return i < 0 ? t : t.slice(i + 1);
  };
  for (const s of g.stories) {
    const d = app.getStory(s.id);
    const fFile = d?.files['findings.json'];
    const raw = fFile && fFile.kind === 'json' ? (fFile.data as Record<string, unknown> | null) : null;
    const list = raw && Array.isArray(raw['findings']) ? (raw['findings'] as Record<string, unknown>[]) : [];
    if (!list.length) continue;
    const cards = new Set(list.map(f => bareId(f['id'])));
    const pe = d?.files['process-events.jsonl'];
    if (!pe || pe.kind !== 'jsonl' || !Array.isArray(pe.rows)) continue;
    for (const r of pe.rows as Record<string, unknown>[]) {
      if (!r || r['type'] !== 'reviewer_finding') continue;
      const ids = r['findingId'] ? [r['findingId']]
        : Array.isArray(r['importedIds']) ? r['importedIds'] as unknown[] : [];
      for (const id of ids)
        check(cards.has(bareId(id)),
          `${s.id}: timeline references ${String(id)} but no finding card normalises to it`);
    }
  }

  // 4. event fidelity: every finding referenced by a process event must be
  //    deliverable to the client. This exists because the wire format used an
  //    allow list of event fields, and `importedIds` -- the batch of findings a
  //    reviewer filed, used by 101 of 134 reviewer_finding events in this repo --
  //    was not on it. The audit passed clean while the UI showed a REVIEW that
  //    had raised 2 critical + 3 high findings as having raised none. Any future
  //    field-level filtering of process events will trip this.
  for (const s of g.stories) {
    const d = app.getStory(s.id);
    const pe = d?.files['process-events.jsonl'];
    if (!pe || pe.kind !== 'jsonl' || !Array.isArray(pe.rows)) continue;
    const fFile = d?.files['findings.json'];
    const raw = fFile && fFile.kind === 'json' ? (fFile.data as Record<string, unknown> | null) : null;
    const list = raw && Array.isArray(raw['findings']) ? (raw['findings'] as Record<string, unknown>[]) : [];
    if (!list.length) continue;
    // Both sides are inconsistently story-qualified across this repo: B-137a
    // stores bare ids with prefixed event refs, B-49ed prefixes both. Compare on
    // the bare id so either spelling matches.
    const bare = (v: unknown): string => {
      const t = String(v);
      return t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t;
    };
    /* Audit/finding containers (B-META-*) are exempt: their findings come from
       `audit` / `finding_add`, not from a reviewer run, so they legitimately have
       no `reviewer_finding` events to be reachable from. They are not lifecycle
       stories and never bounce a phase, which is what this check exists to explain.

       This exemption is load-bearing rather than cosmetic. Before it, such a
       container passed only because it happened to have NO process-events.jsonl at
       all, so the `continue` above skipped it. The first unrelated event written to
       one (a single `finding_add`) made the file exist and the check fire at
       1-of-36 -- a latent failure that had nothing to do with the change that
       tripped it. */
    if (/^B-META/i.test(s.id)) continue;
    const known = new Set(list.map(f => bare(f['id'])));
    let referenced = 0;
    for (const r of pe.rows as Record<string, unknown>[]) {
      if (!r || r['type'] !== 'reviewer_finding') continue;
      const ids = r['findingId'] ? [r['findingId']]
        : Array.isArray(r['importedIds']) ? r['importedIds'] as unknown[] : [];
      for (const id of ids) if (known.has(bare(id))) referenced++;
    }
    // Any story whose reviewers filed findings must expose at least as many
    // event-linked references as there are findings; a shortfall means the
    // timeline cannot explain a phase bounce.
    check(referenced >= known.size,
      `${s.id}: only ${referenced} of ${known.size} findings are reachable from process events`);
  }

  // 4. search: path queries, typo tolerance, story-first ranking, bounded limits
  check(app.searchStories('packages/main', 5).length > 0, 'path query returned nothing');
  check(app.searchStories('package/main', 5).length > 0, 'near-miss path query returned nothing');
  const first = app.searchStories(g.stories[0]!.id, 10)[0];
  check(first?.kind === 'story', 'searching a story id does not rank the story first');
  /* An id, or its hex suffix, must return THAT story first -- not merely some
     story. Searching "45a0" used to put B-45a5 above B-45a0 because bm25 scored
     B-45a5's prose higher, which makes the box useless for navigation. Sampled
     across the graph so one lucky id cannot hide a regression. */
  for (const s of g.stories.filter((_, i) => i % 37 === 0)) {
    const bare = s.id.replace(/^B-/, '');
    for (const query of [s.id, bare]) {
      const top = app.searchStories(query, 10).find(h => h.kind === 'story');
      check(top?.storyId === s.id,
        `searching "${query}" ranked ${top?.storyId ?? 'nothing'} above ${s.id}`);
    }
  }
  check(app.searchStories('a', -1).length <= 500, 'negative limit not clamped');
  check(app.searchStories('x '.repeat(400), 10).length >= 0, 'pathological query threw');
  check(app.searchStories('zzznotathinginthisrepo', 5).length === 0, 'nonsense query matched');

  // 5. unknown ids are rejected, not resolved by path traversal
  check(app.getStory('../../../etc/passwd') === null, 'path traversal was not rejected');
  check(app.getStory('B-nope') === null, 'unknown story id was not rejected');

  app.close();
  const heaviestMb = (heaviest / 1048576).toFixed(1);
  if (fail.length) {
    console.error(`audit FAILED (${fail.length})`);
    for (const f of fail) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`audit PASS · ${g.stories.length} stories · ${g.edges.length} edges · heaviest detail ${heaviestMb}MB (${heaviestId})`);
  }
}

main();
