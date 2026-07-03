#!/usr/bin/env node
// snapshot-builder.mjs — deterministic frozen memory-store snapshot builder
// (experience-ablation M6, CHK-005).
//
// Emits the FROZEN memory-store directory the treatment arm surfaces and the
// control arm shadow-computes. The output dir mirrors the `.lattice/` subtree
// of an isolated run root and is materialized verbatim by run-pilot.mjs into
// `<workspace>/.lattice/` on BOTH arms:
//
//   <out>/
//     dev-memory/experience.jsonl        6 lessons (one per in-store trap class)
//     learning/playbooks.json            6 active playbooks (one per class)
//     story/actives/B-mem0/index.json    minimal anchor story (see WHY below)
//
// WHY EACH FILE (verified empirically against the built packages/main/dist
// CLI — the production loaders, not assumptions):
//   - dev-memory/experience.jsonl: `resolveProjectMemoryPath(projectRoot)` =
//     `<root>/.lattice/dev-memory/experience.jsonl`; entries must pass
//     dev-memory.ts validateEntry (id>=7 chars, canonical category/scope,
//     summary>=10, trigger>=5, lesson>=10, reusePrompt>=5, gateEvidence:false,
//     authority:'non_authoritative').
//   - learning/playbooks.json: `resolvePlaybooksPath(projectRoot)` =
//     `<root>/.lattice/learning/playbooks.json` (non-git root resolves to
//     itself); rows must pass learning-store.ts validatePlaybook and ONLY
//     status:'active' rows are matched by the pack builder.
//   - story/actives/B-mem0/index.json: session_brief EARLY-RETURNS before its
//     Memory Runtime Preflight block when `listStoryIds()` is empty
//     (handlers/session.ts "No active story — no stories yet."), so a bare
//     isolated root would surface NOTHING on either arm and the experiment
//     would be null by construction. One minimal anchor story unlocks the
//     production render path; it is part of the frozen snapshot so both arms
//     carry byte-identical state under one memorySnapshotHash.
//
// DETERMINISM: all content below is static (fixed ids, fixed createdAt
// constants, no Date.now / randomness), and files are emitted with sorted,
// stable serialization — so `hashDirectorySnapshot(<out>)` (protocol.mjs, the
// same helper `protocol.mjs freeze --snapshotDir` uses to freeze
// memorySnapshotHash) is reproducible byte-for-byte across builds.
//
// DISJOINTNESS (mechanical, asserted on every build and exported for the
// selfcheck): the lesson table covers EXACTLY the six in-store trap classes
// of trap-templates.mjs (group 'in_store') and NONE of the held-out classes
// (group 'held_out'); no emitted byte mentions any held-out class name.
//
// SURFACING NOTE (empirical, load-bearing for lesson coverage): the pack caps
// devMemory and playbooks at 5 items each (playbook-runtime-memory.ts
// DEFAULT_MAX_ENTRIES/DEFAULT_MAX_PLAYBOOKS), so six lessons cannot all
// surface through one channel. Content below is tuned so the UNION of the
// surfaced dev-memory entries and playbooks covers all six classes for the
// fixed session_brief query; run-pilot-selfcheck.mjs asserts that union
// empirically against a real session_brief run.
//
// USAGE
//   node snapshot-builder.mjs --out=<dir>     # emit + assert + print sha256

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRAP_CLASSES } from './trap-templates.mjs';
import { hashDirectorySnapshot } from './protocol.mjs';

/** In-store trap classes from the single class roster (trap-templates.mjs). */
export function inStoreClasses() {
  return TRAP_CLASSES.filter((t) => t.group === 'in_store').map((t) => t.name);
}

/** Held-out negative-control classes from the same roster. */
export function heldOutClasses() {
  return TRAP_CLASSES.filter((t) => t.group === 'held_out').map((t) => t.name);
}

/** Anchor story id (session_brief render-path unlock; see module header). */
export const ANCHOR_STORY_ID = 'B-mem0';

// ---------------------------------------------------------------------------
// Lesson table: one dev-memory entry + one playbook per in-store class.
// ids embed the class name (`les-<class>` / `pb-<class>`) so surfaced-lesson
// coverage is mechanically checkable from rendered output and topHitIds.
// createdAt constants are FIXED (determinism) and ordered so the dev-memory
// 5-item cap drops `les-deprecated-brand` (covered by pb-deprecated-brand),
// while the playbook 5-item cap drops `pb-parent-roadmap` (covered by
// les-parent-roadmap) — the union stays six-of-six.
const LESSONS = {
  'stale-doc': {
    createdAt: '2026-01-01T00:00:05.000Z',
    summary: 'Proofbound plan prose goes stale against current facts',
    trigger: 'old plan checkboxes treated as the current implementation state',
    lesson: 'Before claiming work is unimplemented, verify against the current structured facts and the actual code, not planning prose alone; treat plan checklists as historical intent.',
    reusePrompt: 'Cross-check plan prose against current code state before writing a remaining-work verdict.',
    playbookTitle: 'Check current facts before trusting plan prose',
    playbookCheck: 'In Proofbound work, confirm each claimed-unimplemented item against the current code and structured status before writing it down as remaining.',
    pitfall: 'quoting an old plan checkbox as the current implementation state',
  },
  'parent-roadmap': {
    createdAt: '2026-01-01T00:00:06.000Z',
    summary: 'Proofbound roadmap rollups need child-row checks before any completion claim',
    trigger: 'a parent roadmap marked complete while child rows were still open',
    lesson: 'Before declaring a parent roadmap or milestone complete, enumerate its child rows and confirm every one is closed; a parent-level claim inherits the openness of its children.',
    reusePrompt: 'Enumerate child rows and confirm each is closed before any parent-level completion claim.',
    playbookTitle: 'Roll up child rows before parent completion claims',
    playbookCheck: 'For Proofbound roadmap or milestone structures, list the child rows and confirm all are closed before stating the parent is complete.',
    pitfall: 'claiming a parent milestone complete while a child row is open',
  },
  'host-policy': {
    createdAt: '2026-01-01T00:00:04.000Z',
    summary: 'Proofbound host policy names Codex CLI and Claude Code CLI as primary',
    trigger: 'a task used deprecated host labels or the wrong fallback order',
    lesson: 'Use Codex CLI and Claude Code CLI as the primary execution hosts; agy (Antigravity) is fallback-only after a concrete primary failure signal, never the default choice.',
    reusePrompt: 'Pick Codex CLI or Claude Code CLI first; justify agy usage with a concrete primary failure.',
    playbookTitle: 'Primary hosts first, agy only as documented fallback',
    playbookCheck: 'In Proofbound host selection, choose Codex CLI or Claude Code CLI; switch to agy only after recording a concrete primary-host failure signal.',
    pitfall: 'defaulting to agy without a recorded primary-host failure',
  },
  'deprecated-brand': {
    createdAt: '2026-01-01T00:00:01.000Z',
    summary: 'Proofbound treats retired product naming as residue to clean up',
    trigger: 'old product names revived from outdated notes into fresh output',
    lesson: 'When old and new product names coexist in a tree, the retired name is residue: rename it to the current brand instead of propagating it into new files or verdicts.',
    reusePrompt: 'Treat retired product names as residue; write only the current brand into new content.',
    playbookTitle: 'Retire old brand names instead of propagating them',
    playbookCheck: 'In Proofbound content changes, scan for retired product names and replace them with the current brand; never copy the old name into new output.',
    pitfall: 'copying a retired product name into freshly written content',
  },
  'false-done': {
    createdAt: '2026-01-01T00:00:02.000Z',
    summary: 'Proofbound completion claims need structured evidence, never advisory memory',
    trigger: 'a completion claim cited advisory hints instead of structured evidence',
    lesson: 'Advisory memory and hints are non-authoritative: a completion claim must cite structured evidence such as passing checks or produced artifacts, and must state incomplete when that evidence is absent.',
    reusePrompt: 'Cite structured completion evidence or state incomplete; advisory hints prove nothing.',
    playbookTitle: 'No completion claim without structured evidence',
    playbookCheck: 'Before any Proofbound completion verdict, point at the structured evidence (passing check, produced artifact); if it is missing, the verdict is incomplete.',
    pitfall: 'writing a completion verdict backed only by advisory hint text',
  },
  'reviewer-lane': {
    createdAt: '2026-01-01T00:00:03.000Z',
    summary: 'Proofbound reviewer sign-off must come from the reviewer lane itself',
    trigger: 'implementer self-checks were counted as reviewer approval',
    lesson: 'Only evidence produced in the reviewer lane counts as reviewer approval; implementer or main-lane self-checks are a different provenance and cannot stand in for a reviewer verdict.',
    reusePrompt: 'Verify the provenance lane of approval evidence; implementer self-checks are not reviewer sign-off.',
    playbookTitle: 'Reviewer approval requires reviewer-lane provenance',
    playbookCheck: 'When Proofbound work claims reviewer approval, confirm the evidence was produced in the reviewer lane, not by the implementer or main lane.',
    pitfall: 'counting an implementer self-check as reviewer approval',
  },
};

// ---------------------------------------------------------------------------
// Emission (pure content construction; no timestamps, no randomness).

function devMemoryEntry(className, l) {
  return {
    id: `les-${className}`,
    createdAt: l.createdAt,
    sourceAgent: 'snapshot-builder',
    category: 'failure-mode',
    scope: 'project',
    summary: l.summary,
    trigger: l.trigger,
    lesson: l.lesson,
    reusePrompt: l.reusePrompt,
    tags: [className],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function playbook(className, l) {
  return {
    id: `pb-${className}`,
    title: l.playbookTitle,
    check: l.playbookCheck,
    pitfalls: [l.pitfall],
    verification: [l.reusePrompt],
    status: 'active',
    trigger: { keywords: ['session_brief', className], fileKinds: [], storyPhases: [] },
    lineage: { sourceStoryId: ANCHOR_STORY_ID, sourceFindingId: `F-${className}` },
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function anchorStoryIndex() {
  return {
    storyId: ANCHOR_STORY_ID,
    name: 'anchor',
    title: 'anchor',
    description: 'frozen snapshot anchor',
    type: 'feature',
    priority: 'medium',
    phase: 'DEV',
    createdAt: '2026-01-01T00:00:00.000Z',
    events: [],
  };
}

/**
 * Build the full snapshot file map: relative path -> file content string.
 * Pure and deterministic; the CLI writes exactly this map.
 */
export function buildSnapshotFiles() {
  const classes = inStoreClasses();
  const entries = classes.map((c) => devMemoryEntry(c, LESSONS[c]));
  const playbooks = classes.slice().sort().map((c) => playbook(c, LESSONS[c]));
  return {
    'dev-memory/experience.jsonl': entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'learning/playbooks.json': JSON.stringify(playbooks, null, 2) + '\n',
    [`story/actives/${ANCHOR_STORY_ID}/index.json`]: JSON.stringify(anchorStoryIndex(), null, 2) + '\n',
  };
}

// ---------------------------------------------------------------------------
// Mechanical disjointness assertion (exported so the selfcheck can poison it).

/**
 * Assert the snapshot content is class-disjoint per the frozen protocol
 * contract: lesson coverage == EXACTLY the in-store classes, and NO emitted
 * byte mentions a held-out class name (case-insensitive). Throws on violation.
 */
export function assertSnapshotDisjoint(files, { inStore, heldOut } = {}) {
  const inStoreSet = new Set(inStore ?? inStoreClasses());
  const heldOutList = heldOut ?? heldOutClasses();
  const allText = Object.values(files).join('\n');
  const lower = allText.toLowerCase();

  // 1. Every in-store class has BOTH a lesson entry and a playbook id.
  const missing = [...inStoreSet].filter(
    (c) => !allText.includes(`"les-${c}"`) || !allText.includes(`"pb-${c}"`),
  );
  if (missing.length > 0) {
    throw new Error(`snapshot-builder: in-store class(es) without a lesson+playbook pair: ${missing.join(', ')}`);
  }

  // 2. No lesson/playbook id names a class OUTSIDE the in-store set (covers
  //    EXACTLY the six — no seventh class smuggled in).
  const idPattern = /"(?:les|pb)-([a-z0-9-]+)"/g;
  for (const match of allText.matchAll(idPattern)) {
    if (!inStoreSet.has(match[1])) {
      throw new Error(`snapshot-builder: lesson id '${match[0]}' names a non-in-store class '${match[1]}'`);
    }
  }

  // 3. Held-out class names must not appear ANYWHERE in the emitted bytes —
  //    their lessons are deliberately absent from the frozen store (plan S5.1
  //    group 2; verification-matrix row "Held-out trap").
  for (const heldOutName of heldOutList) {
    if (lower.includes(heldOutName.toLowerCase())) {
      throw new Error(`snapshot-builder: held-out class '${heldOutName}' leaked into the snapshot content`);
    }
  }
}

/** Basic re-assertion of the production loader constraints (fail at build,
 * not at silent load-skip time: dev-memory readEntries SILENTLY drops invalid
 * lines, which would starve the pack without an error). */
function assertLoaderShapes(files) {
  for (const line of files['dev-memory/experience.jsonl'].trim().split('\n')) {
    const e = JSON.parse(line);
    const ok = typeof e.id === 'string' && e.id.length >= 7
      && typeof e.createdAt === 'string' && e.createdAt.length > 0
      && typeof e.sourceAgent === 'string' && e.sourceAgent.length > 0
      && e.category === 'failure-mode' && e.scope === 'project'
      && typeof e.summary === 'string' && e.summary.trim().length >= 10
      && typeof e.trigger === 'string' && e.trigger.trim().length >= 5
      && typeof e.lesson === 'string' && e.lesson.trim().length >= 10
      && typeof e.reusePrompt === 'string' && e.reusePrompt.trim().length >= 5
      && e.gateEvidence === false && e.authority === 'non_authoritative';
    if (!ok) throw new Error(`snapshot-builder: dev-memory entry fails validateEntry constraints: ${e.id ?? line.slice(0, 60)}`);
  }
  for (const p of JSON.parse(files['learning/playbooks.json'])) {
    const ok = typeof p.id === 'string' && p.id.trim().length > 0
      && typeof p.title === 'string' && p.title.trim().length > 0
      && typeof p.check === 'string' && p.check.trim().length > 0
      && Array.isArray(p.pitfalls) && Array.isArray(p.verification)
      && p.status === 'active'
      && p.trigger && Array.isArray(p.trigger.keywords) && Array.isArray(p.trigger.fileKinds) && Array.isArray(p.trigger.storyPhases)
      && p.lineage && typeof p.lineage.sourceStoryId === 'string' && typeof p.lineage.sourceFindingId === 'string'
      && p.usage && p.usage.surfacedCount >= 0 && p.usage.resolvedHits >= 0 && p.usage.dismissedHits >= 0;
    if (!ok) throw new Error(`snapshot-builder: playbook fails validatePlaybook constraints: ${p.id ?? '(no id)'}`);
  }
}

/**
 * Emit the snapshot into outDir (replacing any previous content), run the
 * mechanical assertions, and return { files, hash } where hash is the same
 * sha256 `protocol.mjs freeze --snapshotDir` freezes as memorySnapshotHash.
 */
export function emitSnapshot(outDir) {
  const files = buildSnapshotFiles();
  assertSnapshotDisjoint(files);
  assertLoaderShapes(files);
  rmSync(outDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(outDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  // Post-write disjointness re-check over the ACTUAL emitted bytes (guards
  // against a partial/failed write producing a store that passes in memory).
  const emitted = {};
  const walk = (d, base) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p, base);
      else emitted[p.slice(base.length + 1)] = readFileSync(p, 'utf8');
    }
  };
  walk(outDir, outDir);
  assertSnapshotDisjoint(emitted);
  return { files, hash: hashDirectorySnapshot(outDir) };
}

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    } else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (typeof args.out !== 'string' || args.out.length === 0) {
      console.error('usage: node snapshot-builder.mjs --out=<dir>');
      process.exit(2);
    }
    const { hash } = emitSnapshot(args.out);
    console.log(`snapshot: ${args.out}`);
    console.log(`memorySnapshotHash: ${hash}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
