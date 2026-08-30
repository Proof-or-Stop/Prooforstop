#!/usr/bin/env node
/**
 * B-8df9 CHK-002 receipt — the verdict hash is TOTAL and DETERMINISTIC over every
 * on-disk shape of `agentResults`, and it DISCRIMINATES the edits the gate cares about.
 *
 * CHK-001's artifact (red-b8df9-init-check-verdict-signature.mjs) proves the gate now
 * refuses a hand-edited verdict. It exercises exactly one shape: the canonical pair a
 * fresh story produces. This file covers the rest of the corpus, because a domain that
 * throws — or silently collapses two different records onto one digest — on a shape the
 * repository actually contains would break stories that never did anything wrong.
 *
 * ── WHY THE SHAPES ARE CONSTRUCTED AND MEASURED, BOTH ───────────────────────────────
 *
 * The story's background enumerated six shapes measured at commit c59f9c0113. Two of
 * them (the pre-rename `koala-*` actors and files carrying NO `agentResults` field) are
 * NOT in the corpus this file runs against — the story directory moved and the corpus
 * shrank. So each shape is CONSTRUCTED here, from its documented description, and the
 * live corpus is separately RE-DERIVED at runtime and reported. Neither substitutes for
 * the other: constructed shapes keep coverage of records that exist in older trees and
 * in git history, while the measured inventory keeps this file honest about which of
 * them are still real. A shape that has left the corpus is REPORTED, never asserted
 * away, and no count in this file is a literal — every number is measured on the run
 * that prints it.
 *
 * ── WHAT ABSENCE HASHES TO (open question #1, answered mechanically) ────────────────
 *
 * `computeInitCheckVerdictHash` hashes two components: `raw` (the persisted values,
 * verbatim, with an absent field as the JSON `null` sentinel) and `consumed` (the array
 * `initCheckAgentResults` returns, which is SYNTHESIZED from top-level agentId /
 * checkedAt / issues when `agentResults` is missing).
 *
 * So an absent field does NOT hash to its synthesized value — row X1 asserts the two are
 * distinguishable — and the synthesis inputs are nevertheless bound, which row X2
 * asserts by editing the top-level `agentId` of a record that has no `agentResults` and
 * requiring the digest to move. Hashing only `raw` would leave that edit invisible (the
 * gate would believe a different reviewer had signed off); hashing only `consumed` would
 * accept re-encodings of a record nobody wrote. Both components exist for a stated
 * reason, and each has a row that fails if it is dropped.
 *
 * ── CONTROLS ────────────────────────────────────────────────────────────────────────
 *
 * "the hash is a constant" would make every determinism row pass vacuously, so C0
 * requires two different verdicts to produce two different digests before any
 * determinism claim is reported. If a control misbehaves the run prints BROKEN, draws
 * no conclusion, and exits 2.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────
 *
 * Read-only. No story is written, no child process is spawned, and no file content is
 * printed — corpus findings are reported as counts and shape labels only.
 *
 * Exit 0 = pass, 1 = a claim failed, 2 = a control is broken.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..', '..');   // packages/main/tests/red -> repo root
const DIST = join(REPO, 'packages', 'main', 'dist');

const {
  computeInitCheckVerdictHash,
  initCheckAgentResults,
  describeInitCheckSignatureDomain,
  INIT_CHECK_SIGNATURE_DOMAIN,
} = await import(join(DIST, 'core', 'init-check-gate.js'));

const rows = [];
const add = (id, claim, ok, observed) => rows.push({ id, claim, verdict: ok ? 'PASS' : 'FAIL', observed });
const ctl = (id, claim, ok, observed) => rows.push({ id, claim, verdict: ok ? 'CONTROL-OK' : 'BROKEN', observed });

/** Reverse every object's key order, so key order cannot be what makes a digest stable. */
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).reverse()) out[key] = reorder(value[key]);
    return out;
  }
  return value;
}
const roundTrip = (value) => JSON.parse(JSON.stringify(reorder(value)));

const AT = '1970-01-01T00:00:00.000Z';
const entry = (agentId, issues = []) => ({ agentId, checkedAt: AT, issues });
const blocker = { severity: 'critical', desc: 'A recorded blocker that must not be erasable by hand.' };

/**
 * The six documented on-disk shapes, each described by how it is RECOGNISED rather than
 * by how many files carried it — the counts drift, the structures do not.
 */
const SHAPES = [
  {
    label: 'canonical pair',
    match: (r) => r.length === 2 && r.some(e => e.agentId === 'proof-or-stop-review-story-init') && r.some(e => e.agentId === 'product-reviewer'),
    record: { storyId: 'B-shape', checkedAt: AT, reviewRound: '', agentId: 'proof-or-stop-review-story-init', issues: [], agentResults: [entry('proof-or-stop-review-story-init'), entry('product-reviewer')] },
  },
  {
    label: 'koala-* pair (pre-rename actor)',
    match: (r) => r.some(e => e.agentId === 'koala-review-story-init'),
    record: { storyId: 'B-shape', checkedAt: AT, reviewRound: '', agentId: 'koala-review-story-init', issues: [], agentResults: [entry('koala-review-story-init'), entry('product-reviewer')] },
  },
  {
    label: 'proof-or-stop-*@fallback pair',
    match: (r) => r.some(e => e.agentId === 'proof-or-stop-review-story-init@fallback'),
    record: { storyId: 'B-shape', checkedAt: AT, reviewRound: '', agentId: 'proof-or-stop-review-story-init@fallback', issues: [], agentResults: [entry('proof-or-stop-review-story-init@fallback'), entry('product-reviewer@fallback')], fallback: { mode: 'repair', reason: 'x'.repeat(30), attestedAt: AT } },
  },
  {
    label: 'koala-*@fallback pair',
    match: (r) => r.some(e => e.agentId === 'koala-review-story-init@fallback'),
    record: { storyId: 'B-shape', checkedAt: AT, reviewRound: '', agentId: 'koala-review-story-init@fallback', issues: [], agentResults: [entry('koala-review-story-init@fallback'), entry('product-reviewer@fallback')], fallback: { mode: 'fallback', reason: 'x'.repeat(30), attestedAt: AT } },
  },
  {
    label: 'three-entry historical actor',
    match: (r) => r.length >= 3,
    record: { storyId: 'B-shape', checkedAt: AT, reviewRound: '', agentId: 'codex-init-reviewer', issues: [], agentResults: [entry('codex-init-reviewer'), entry('proof-or-stop-review-story-init'), entry('product-reviewer')] },
  },
  {
    label: 'no agentResults field (synthesized from top-level fields)',
    match: null,   // recognised by the ABSENCE of the field, checked separately
    record: { storyId: 'B-shape', checkedAt: AT, reviewRound: '', agentId: 'proof-or-stop-review-story-init', issues: [blocker] },
  },
];

// ── C0: the digest discriminates at all ─────────────────────────────────────────────
const digestA = computeInitCheckVerdictHash(SHAPES[0].record);
const digestB = computeInitCheckVerdictHash(SHAPES[4].record);
ctl('C0', 'CONTROL: two different verdicts produce two different digests (the hash is not a constant)',
  typeof digestA === 'string' && digestA.length === 64 && digestA !== digestB,
  `distinct=${digestA !== digestB} digestLength=${digestA.length}`);

// ── S: every documented shape is total + deterministic, and none collide ────────────
const seen = new Map();
for (const [index, shape] of SHAPES.entries()) {
  let ok = false;
  let observed;
  try {
    const first = computeInitCheckVerdictHash(shape.record);
    const again = computeInitCheckVerdictHash(shape.record);
    const afterDisk = computeInitCheckVerdictHash(roundTrip(shape.record));
    initCheckAgentResults(shape.record);   // the gate's own read must not throw either
    ok = first === again && first === afterDisk;
    observed = `stableAcrossCalls=${first === again} stableAcrossJsonRoundTripWithReorderedKeys=${first === afterDisk}`;
    if (!seen.has(first)) seen.set(first, []);
    seen.get(first).push(shape.label);
  } catch (e) {
    observed = `threw ${e?.constructor?.name ?? 'Error'}`;
  }
  add(`S${index + 1}`, `shape hashes deterministically and does not throw: ${shape.label}`, ok, observed);
}
const collisions = [...seen.values()].filter(labels => labels.length > 1);
add('S7', 'the documented shapes do not collide onto one digest',
  collisions.length === 0,
  `distinctDigests=${seen.size} of shapes=${SHAPES.length}; collisions=${collisions.map(c => c.join(' == ')).join('; ') || 'none'}`);

// ── X: what ABSENCE hashes to, and why the synthesis inputs are still bound ─────────
{
  const absent = SHAPES[SHAPES.length - 1].record;
  const explicit = { ...absent, agentResults: initCheckAgentResults(absent) };
  add('X1', 'an ABSENT agentResults is a DISTINCT value from its explicit synthesized encoding (absence is not equated with the synthesis)',
    computeInitCheckVerdictHash(absent) !== computeInitCheckVerdictHash(explicit),
    `absentDigestDiffersFromExplicitEncoding=${computeInitCheckVerdictHash(absent) !== computeInitCheckVerdictHash(explicit)}`);

  const impersonated = { ...absent, agentId: 'product-reviewer' };
  add('X2', 'on a record with NO agentResults, editing the top-level agentId the gate synthesizes from MOVES the digest',
    computeInitCheckVerdictHash(absent) !== computeInitCheckVerdictHash(impersonated),
    `digestMoved=${computeInitCheckVerdictHash(absent) !== computeInitCheckVerdictHash(impersonated)}`);
}

// ── D: the two edits the gate decides on both move the digest ───────────────────────
{
  const base = SHAPES[0].record;
  const injected = { ...base, agentResults: [...base.agentResults, entry('fabricated-reviewer')] };
  add('D1', 'INJECTING a reviewer record moves the digest',
    computeInitCheckVerdictHash(base) !== computeInitCheckVerdictHash(injected),
    `digestMoved=${computeInitCheckVerdictHash(base) !== computeInitCheckVerdictHash(injected)}`);

  const recorded = { ...base, issues: [blocker], agentResults: [entry('proof-or-stop-review-story-init', [blocker]), entry('product-reviewer')] };
  const erased = { ...recorded, issues: [], agentResults: [entry('proof-or-stop-review-story-init'), entry('product-reviewer')] };
  add('D2', 'ERASING a recorded blocking issue moves the digest',
    computeInitCheckVerdictHash(recorded) !== computeInitCheckVerdictHash(erased),
    `digestMoved=${computeInitCheckVerdictHash(recorded) !== computeInitCheckVerdictHash(erased)}`);

  const topLevelOnly = { ...recorded, issues: [] };
  add('D3', 'editing the top-level issues array moves the digest even where the gate reads agentResults instead',
    computeInitCheckVerdictHash(recorded) !== computeInitCheckVerdictHash(topLevelOnly),
    `digestMoved=${computeInitCheckVerdictHash(recorded) !== computeInitCheckVerdictHash(topLevelOnly)}`);
}

// ── M: the tamper message is DERIVED from the domain, not restated ──────────────────
{
  const rendered = describeInitCheckSignatureDomain();
  const everyLabelRendered = INIT_CHECK_SIGNATURE_DOMAIN.every(component => rendered.includes(component.label));
  add('M1', 'the domain renderer emits every declared component, so widening the domain widens the message',
    everyLabelRendered && INIT_CHECK_SIGNATURE_DOMAIN.length > 0,
    `componentsDeclared=${INIT_CHECK_SIGNATURE_DOMAIN.length} allRendered=${everyLabelRendered}`);

  let guard = '';
  try { guard = readFileSync(join(DIST, 'core', 'machine.js'), 'utf8'); } catch { guard = ''; }
  const rendersDomain = guard.includes('describeInitCheckSignatureDomain');
  const restatesStaleList = guard.includes('background/title/description/checklist were modified');
  add('M2', 'the shipped guard RENDERS the domain in its tamper message instead of restating a field list',
    rendersDomain && !restatesStaleList,
    `rendersDomain=${rendersDomain} stillCarriesTheOldHandWrittenList=${restatesStaleList}`);
}

// ── L: the LIVE corpus, re-derived on this run (never copied from prose) ────────────
{
  let storyDir = '.proof-or-stop/story/actives';
  try {
    const cfg = JSON.parse(readFileSync(join(REPO, 'proof-or-stop.config.json'), 'utf8'));
    if (typeof cfg?.storyDir === 'string' && cfg.storyDir.length > 0) storyDir = cfg.storyDir;
  } catch { /* PROBE: fall back to the default layout below */ }
  const abs = join(REPO, storyDir);

  let files = 0, threw = 0, unstable = 0, absentField = 0;
  const present = new Set();
  if (existsSync(abs)) {
    for (const dir of readdirSync(abs, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const path = join(abs, dir.name, 'init-check.json');
      if (!existsSync(path)) continue;
      files += 1;
      let data;
      try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { threw += 1; continue; }
      try {
        const first = computeInitCheckVerdictHash(data);
        const again = computeInitCheckVerdictHash(JSON.parse(readFileSync(path, 'utf8')));
        if (first !== again) unstable += 1;
        const results = initCheckAgentResults(data);
        if (!Array.isArray(data.agentResults)) { absentField += 1; present.add(SHAPES[SHAPES.length - 1].label); }
        for (const shape of SHAPES) if (shape.match && shape.match(results)) present.add(shape.label);
      } catch { threw += 1; }
    }
  }
  const missing = SHAPES.map(s => s.label).filter(label => !present.has(label));
  add('L1', 'every init-check.json in the live corpus hashes without throwing and without varying between reads',
    files > 0 && threw === 0 && unstable === 0,
    `filesMeasuredOnThisRun=${files} threw=${threw} unstable=${unstable} recordsWithNoAgentResultsField=${absentField}`);
  rows.push({
    id: 'L2',
    claim: 'documented shapes still present in the live corpus (measured, not asserted — a shape that has left the corpus is reported, not failed)',
    verdict: 'MEASURED',
    observed: `present=[${[...present].join(' | ') || 'none'}]; absentFromThisCorpus=[${missing.join(' | ') || 'none'}] — those are still covered by the constructed rows above`,
  });
}

console.log('=== B-8df9 CHK-002: the verdict hash over every on-disk agentResults shape ===\n');
let failed = 0, broken = 0;
for (const { id, claim, verdict, observed } of rows) {
  if (verdict === 'FAIL') failed += 1;
  if (verdict === 'BROKEN') broken += 1;
  console.log(`  ${id.padEnd(3)} [${verdict.padEnd(10)}] ${claim}`);
  console.log(`      observed: ${observed}`);
}
console.log(`\n  ${failed} FAILED / ${broken} BROKEN / ${rows.length} rows`);
console.log(`  signed components rendered from the domain declaration: ${describeInitCheckSignatureDomain()}`);

if (broken > 0) {
  console.log('\n  A CONTROL IS BROKEN: the digest no longer discriminates, so no determinism row above means anything.\n');
  process.exit(2);
}
if (failed > 0) {
  console.log('\n  FAILED: the verdict domain is not total, not deterministic, or no longer discriminates an edit the gate decides on.\n');
  process.exit(1);
}
console.log('\n  PASS: total and deterministic over every documented shape, and each gate-relevant edit moves the digest.\n');
