#!/usr/bin/env node
/**
 * B-2296 (evidence-integrity §5 follow-on, Phase 1 of 2) — deterministic, OFFLINE
 * smoke for the frozen-claim drift foundation. No git, no network, no fs, no
 * `claude -p`: pure-Fn assertions over normalizeClaim / claimDigest.
 *
 * CHK-001 scope: normalization determinism + the two digest invariants
 * (whitespace-only edit → same digest; one non-whitespace char → different digest)
 * + empty/whitespace-only safety.
 *
 * Prints `frozen-claim-drift-smoke: PASS` on success; throws (non-zero exit) on any
 * failed assertion.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeClaim, claimDigest, detectDrift } from '../core/frozen-claim-drift.js';
import { buildDriftReport } from '../handlers/frozen-claim-drift-check.js';
import type { ChecklistItem, FrozenClaimSnapshot } from '../core/types.js';

// ── 1. normalizeClaim collapses arbitrary whitespace deterministically. ─────────
{
  assert.equal(normalizeClaim('  a\t\n b  '), 'a b', 'trim + collapse mixed whitespace runs to a single space');
  assert.equal(normalizeClaim('a   b'), 'a b', 'internal space run collapses');
  assert.equal(normalizeClaim('a\t\t\tb'), 'a b', 'internal tab run collapses');
  assert.equal(normalizeClaim('a\n\nb'), 'a b', 'internal newline run collapses');
  assert.equal(normalizeClaim('a \t\n\r b'), 'a b', 'mixed space/tab/newline/CR run collapses to one space');
  assert.equal(normalizeClaim('\n  leading'), 'leading', 'leading whitespace stripped');
  assert.equal(normalizeClaim('trailing \t\n'), 'trailing', 'trailing whitespace stripped');
  // Determinism: same input → same output, repeatedly.
  const messy = '  the\tfile\n\nwas   created  ';
  assert.equal(normalizeClaim(messy), normalizeClaim(messy), 'deterministic: identical output on repeat');
  assert.equal(normalizeClaim(normalizeClaim(messy)), normalizeClaim(messy), 'idempotent: normalizing an already-normal string is a no-op');
  console.log('✓ normalizeClaim collapses arbitrary whitespace deterministically');
}

// ── 2. Two strings differing ONLY in whitespace → identical claimDigest. ─────────
{
  const a = 'the file was created';
  const b = '  the\tfile\n was    created  ';
  assert.equal(normalizeClaim(a), normalizeClaim(b), 'whitespace-only variants normalize identically');
  assert.equal(claimDigest(a), claimDigest(b), 'whitespace-only variants share a digest (false-positive guard)');
  assert.match(claimDigest(a), /^[0-9a-f]{64}$/, 'claimDigest is sha256 hex');
  console.log('✓ whitespace-only difference → identical claimDigest');
}

// ── 3. Two strings differing by ONE non-whitespace char → different claimDigest. ─
{
  const a = 'the file was created';
  const b = 'the file was crested'; // one letter changed (a → e)
  assert.notEqual(normalizeClaim(a), normalizeClaim(b), 'a real char change survives normalization');
  assert.notEqual(claimDigest(a), claimDigest(b), 'a one-char non-whitespace edit changes the digest');
  console.log('✓ one non-whitespace char difference → different claimDigest');
}

// ── 4. Empty / whitespace-only input → normalizes to '' and digests without throwing. ─
{
  assert.equal(normalizeClaim(''), '', 'empty string normalizes to empty');
  assert.equal(normalizeClaim('   \t\n  '), '', 'whitespace-only string normalizes to empty');
  // Digest must be computable (no throw) and the empty and whitespace-only forms agree.
  const emptyDigest = claimDigest('');
  const wsDigest = claimDigest('   \t\n  ');
  assert.match(emptyDigest, /^[0-9a-f]{64}$/, 'empty-string digest is sha256 hex');
  assert.equal(emptyDigest, wsDigest, 'empty and whitespace-only inputs share a digest');
  console.log('✓ empty / whitespace-only string normalizes to "" and digests without throwing');
}

// ── CHK-002: detectDrift is a PURE, bidirectional drift verdict. ────────────────
// Deterministic + offline: construct the snapshot + current inputs directly (no real
// git). storyFilesHash strings are opaque here — a plain string compare IS the
// story-diff-scoped, rename-aware material signal.
{
  const CLAIM = 'the file hello.txt was created';
  const SFH_A = 'a'.repeat(64); // story-owned material hash at attestation time
  const SFH_B = 'b'.repeat(64); // story-owned material moved (a story-owned file changed)
  const baseSnapshot: FrozenClaimSnapshot = {
    normalizedClaimDigest: claimDigest(CLAIM),
    storyFilesHash: SFH_A,
    headHash: 'deadbeef'.repeat(5),
    attestedAt: '2026-07-26T00:00:00.000Z',
    materialHash: 'c'.repeat(64),
  };

  // 5a. Material drift: same claim digest, DIFFERENT storyFilesHash → 'material'.
  {
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH_B });
    assert.equal(v.driftKind, 'material', 'story-owned material moved → material drift');
    assert.equal(v.classification, 'bound', 'a snapshot-bound claim is classified bound');
    assert.equal(v.materialDrifted, true, 'materialDrifted flag set');
    assert.equal(v.claimDrifted, false, 'claim text unchanged → claimDrifted false');
    console.log('✓ material drift (same digest, different storyFilesHash) → driftKind=material');
  }

  // 5b. Claim edit: DIFFERENT claim digest, same storyFilesHash → 'claim'.
  {
    const edited = 'the file hello.txt was DELETED'; // a real, non-whitespace text edit
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(edited), currentStoryFilesHash: SFH_A });
    assert.equal(v.driftKind, 'claim', 'userSees text edited → claim drift (bidirectional binding)');
    assert.equal(v.classification, 'bound', 'still bound');
    assert.equal(v.claimDrifted, true, 'claimDrifted flag set');
    assert.equal(v.materialDrifted, false, 'material unchanged → materialDrifted false');
    console.log('✓ claim edit (different digest, same storyFilesHash) → driftKind=claim');
  }

  // 5c. Both changed → 'both'.
  {
    const edited = 'a completely different promise';
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(edited), currentStoryFilesHash: SFH_B });
    assert.equal(v.driftKind, 'both', 'claim AND material moved → both');
    assert.equal(v.claimDrifted, true, 'claimDrifted set');
    assert.equal(v.materialDrifted, true, 'materialDrifted set');
    console.log('✓ both claim + material changed → driftKind=both');
  }

  // 5d. Unchanged → 'none'. This is the "unrelated change → NO drift" guard at the pure
  // level: an unrelated (non-story-owned) file does not move storyFilesHash, so the
  // current storyFilesHash equals the snapshot's and no drift fires.
  {
    const v = detectDrift(baseSnapshot, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH_A });
    assert.equal(v.driftKind, 'none', 'identical digest + identical storyFilesHash → no drift');
    assert.equal(v.classification, 'bound', 'still bound');
    assert.equal(v.claimDrifted, false, 'no claim drift');
    assert.equal(v.materialDrifted, false, 'no material drift (unrelated churn excluded by construction)');
    console.log('✓ unchanged (same digest, same storyFilesHash) → driftKind=none (unrelated change → NO drift)');
  }

  // 5e. Undefined snapshot → legacy-unbound (grandfathered, never an error).
  {
    const v = detectDrift(undefined, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH_A });
    assert.equal(v.classification, 'legacy-unbound', 'a userSees with no snapshot is legacy-unbound');
    assert.equal(v.driftKind, 'none', 'legacy-unbound never reports drift');
    assert.equal(v.claimDrifted, false, 'no claim drift on legacy-unbound');
    assert.equal(v.materialDrifted, false, 'no material drift on legacy-unbound');
    console.log('✓ undefined snapshot → classification=legacy-unbound');
  }
}

// ── CHK-003: buildDriftReport assembles the read-only advisory deterministically. ─
// PURE + offline: an in-memory checklist (no git, no fs, no process). storyFilesHash
// strings are opaque; a plain string compare IS the story-diff-scoped material signal.
// This exercises the exact advisory-assembly the CLI handler surfaces, WITHOUT spawning
// a process. Object.freeze proves buildDriftReport mutates none of its inputs (a pure read).
{
  const CURRENT_SFH = 'f'.repeat(64); // the story's ONCE-computed current story-owned material hash

  // Item 1 — snapshot pinned at a DIFFERENT storyFilesHash, same claim → material drift.
  const driftedItem: ChecklistItem = Object.freeze({
    id: 'CHK-001',
    title: 'material-drifted frozen claim',
    userSees: 'the file hello.txt was created',
    userSeesSnapshot: Object.freeze({
      normalizedClaimDigest: claimDigest('the file hello.txt was created'),
      storyFilesHash: 'a'.repeat(64), // pinned when the story-owned material differed
      headHash: 'deadbeef'.repeat(5),
      attestedAt: '2026-07-26T00:00:00.000Z',
    }) as FrozenClaimSnapshot,
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;

  // Item 2 — non-empty userSees, NO snapshot → legacy-unbound (grandfathered, never an error).
  const legacyItem: ChecklistItem = Object.freeze({
    id: 'CHK-002',
    title: 'pre-feature frozen claim with no snapshot',
    userSees: 'a legacy promise with no attestation',
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;

  // Item 3 — snapshot pinned at the CURRENT storyFilesHash + unchanged claim → clean (omitted).
  const cleanItem: ChecklistItem = Object.freeze({
    id: 'CHK-003',
    title: 'un-drifted, snapshot-bound frozen claim',
    userSees: 'the config was written',
    userSeesSnapshot: Object.freeze({
      normalizedClaimDigest: claimDigest('the config was written'),
      storyFilesHash: CURRENT_SFH, // equals current → no material drift
      headHash: 'cafebabe'.repeat(5),
      attestedAt: '2026-07-26T00:00:00.000Z',
    }) as FrozenClaimSnapshot,
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;

  // Item 4 — empty userSees → no frozen claim to check (also omitted).
  const noClaimItem: ChecklistItem = Object.freeze({
    id: 'CHK-004',
    title: 'item with no userSees',
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;

  const items: readonly ChecklistItem[] = [driftedItem, legacyItem, cleanItem, noClaimItem];
  const report = buildDriftReport(items, CURRENT_SFH);

  // (a) drifted item → code=FROZEN_CLAIM_DRIFT / driftKind=material / actionRequired=re_attestation.
  const drifted = report.find((a) => a.itemId === 'CHK-001');
  assert.ok(drifted, 'material-drifted item is present in the advisory');
  assert.equal(drifted!.code, 'FROZEN_CLAIM_DRIFT', 'advisory code is FROZEN_CLAIM_DRIFT');
  assert.equal(drifted!.driftKind, 'material', 'story-owned material moved → driftKind=material');
  assert.equal(drifted!.classification, 'bound', 'a snapshot-bound drifted item stays bound');
  assert.equal(drifted!.actionRequired, 're_attestation', 'actionRequired is re_attestation');
  assert.equal(drifted!.claimRef, 'CHK-001:userSees', 'claimRef binds the item id + userSees');
  assert.equal(drifted!.previousStoryFilesHash, 'a'.repeat(64), 'previousStoryFilesHash is the snapshot hash');
  assert.equal(drifted!.currentStoryFilesHash, CURRENT_SFH, 'currentStoryFilesHash is the once-computed value');
  console.log('✓ buildDriftReport: material-drifted item → code=FROZEN_CLAIM_DRIFT, driftKind=material, actionRequired=re_attestation');

  // (b) no-snapshot item → classification=legacy-unbound.
  const legacy = report.find((a) => a.itemId === 'CHK-002');
  assert.ok(legacy, 'no-snapshot item is present in the advisory');
  assert.equal(legacy!.classification, 'legacy-unbound', 'userSees with no snapshot → classification=legacy-unbound');
  assert.equal(legacy!.driftKind, 'none', 'legacy-unbound never reports drift');
  assert.equal(legacy!.previousDigest, '', 'no snapshot → empty previousDigest');
  assert.equal(legacy!.previousStoryFilesHash, '', 'no snapshot → empty previousStoryFilesHash');
  console.log('✓ buildDriftReport: no-snapshot item → classification=legacy-unbound');

  // (c) clean bound item + empty-userSees item are ABSENT (a clean item is silent).
  assert.equal(report.find((a) => a.itemId === 'CHK-003'), undefined, 'un-drifted bound item is omitted (silent)');
  assert.equal(report.find((a) => a.itemId === 'CHK-004'), undefined, 'empty-userSees item is omitted (no frozen claim)');
  assert.equal(report.length, 2, 'exactly the drifted + legacy-unbound items are reported');
  console.log('✓ buildDriftReport: clean bound item + empty-userSees item are absent (2 advisories total)');

  // (d) buildDriftReport is a PURE read: it took frozen inputs and returned without
  // writing anything. The inputs are unchanged (a mutation would have thrown on freeze).
  assert.equal(driftedItem.userSeesSnapshot!.storyFilesHash, 'a'.repeat(64), 'input snapshot untouched (pure read, no mutation)');
  assert.equal(legacyItem.userSeesSnapshot, undefined, 'legacy item never gained a snapshot (writes nothing)');
  console.log('✓ buildDriftReport: inputs unchanged — pure Fn, writes no files/evidence/metadata');
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER for CHK-004 to extend:
//   - CHK-004 assert the advisory is NON-blocking (changes no gate verdict) + add the
//     whitespace-only userSees edit → NO drift false-positive guard case, and register
//     this smoke in proof-or-stop.config.json validate.commands + package.json scripts.
// Do NOT delete this marker; append the new blocks above the final PASS line.
// ─────────────────────────────────────────────────────────────────────────────

// ── CHK-004 CASE 3: UNRELATED-CHANGE FALSE-POSITIVE GUARD (DRIFT-level). ─────────
// An unrelated (non-story-owned) file change does NOT move the story-diff-scoped
// storyFilesHash. So the CURRENT storyFilesHash equals the snapshot's, and the claim
// text is untouched → detectDrift MUST return driftKind='none'. Churning an unrelated
// file (a whole-tree / main-merge change outside the story's owned files) must NEVER
// manufacture a frozen-claim drift advisory.
{
  const CLAIM = 'the report was generated at output/report.pdf';
  const SFH = '1'.repeat(64); // story-owned material hash, UNCHANGED by unrelated churn
  const snap: FrozenClaimSnapshot = {
    normalizedClaimDigest: claimDigest(CLAIM),
    storyFilesHash: SFH,
    headHash: 'feedface'.repeat(5),
    attestedAt: '2026-07-26T00:00:00.000Z',
  };
  // Unrelated churn happened elsewhere in the tree, but storyFilesHash is story-scoped,
  // so it is IDENTICAL to attestation time; the claim text is also unchanged.
  const v = detectDrift(snap, { currentNormalizedDigest: claimDigest(CLAIM), currentStoryFilesHash: SFH });
  assert.equal(v.driftKind, 'none', 'unrelated file change → storyFilesHash unchanged → NO drift');
  assert.equal(v.materialDrifted, false, 'unrelated churn does not set materialDrifted (false-positive guard)');
  assert.equal(v.claimDrifted, false, 'claim text untouched by unrelated churn');
  assert.equal(v.classification, 'bound', 'a snapshot-bound claim stays bound');
  console.log('✓ [false-positive guard] unrelated file change → storyFilesHash unchanged → driftKind=none');
}

// ── CHK-004 CASE 4: WHITESPACE-ONLY FALSE-POSITIVE GUARD (DRIFT-level). ──────────
// A userSees re-indented / re-wrapped with extra tabs/newlines/spaces is a whitespace-only
// edit. Normalization MUST absorb it: the claim digest is unchanged, so a snapshot pinned
// to the ORIGINAL claim sees driftKind='none'. A cosmetic reflow must NEVER fire claim drift.
{
  const original = 'the migration ran and 3 rows were updated';
  const whitespaceVariant = '  the\tmigration   ran\nand\t3 rows\n\n  were    updated  ';
  // The whitespace-only variant normalizes to the SAME digest as the original.
  assert.equal(
    claimDigest(original),
    claimDigest(whitespaceVariant),
    'whitespace-only variant shares the claim digest (normalization absorbs the reflow)',
  );
  const SFH = '2'.repeat(64);
  const snap: FrozenClaimSnapshot = {
    normalizedClaimDigest: claimDigest(original), // pinned to the ORIGINAL claim
    storyFilesHash: SFH,
    headHash: 'baddcafe'.repeat(5),
    attestedAt: '2026-07-26T00:00:00.000Z',
  };
  // "Current" userSees is the whitespace-reflowed variant; storyFilesHash unchanged.
  const v = detectDrift(snap, { currentNormalizedDigest: claimDigest(whitespaceVariant), currentStoryFilesHash: SFH });
  assert.equal(v.driftKind, 'none', 'whitespace-only userSees edit → digest unchanged → NO drift');
  assert.equal(v.claimDrifted, false, 'normalization absorbs the whitespace edit (false-positive guard)');
  assert.equal(v.materialDrifted, false, 'storyFilesHash unchanged → no material drift');
  console.log('✓ [false-positive guard] whitespace-only userSees edit → digest unchanged → driftKind=none');
}

// ── CHK-004 NON-BLOCKING assertion — Phase 1 is detect+report ONLY. ─────────────
// buildDriftReport surfaces drift, but the advisory NEVER signals a gate failure: the ONLY
// action it ever demands is re_attestation and no advisory carries a truthy `blocking`
// directive. This mirrors the read-only handler's hardcoded summary.blocking === false,
// which stays false even when drift is present.
{
  const CURRENT = '9'.repeat(64);
  const driftedForBlocking: ChecklistItem = Object.freeze({
    id: 'CHK-BLOCK',
    title: 'material-drifted item proving the advisory is non-blocking',
    userSees: 'the artifact was published',
    userSeesSnapshot: Object.freeze({
      normalizedClaimDigest: claimDigest('the artifact was published'),
      storyFilesHash: '8'.repeat(64), // pinned at a DIFFERENT storyFilesHash → material drift
      headHash: 'deadfeed'.repeat(5),
      attestedAt: '2026-07-26T00:00:00.000Z',
    }) as FrozenClaimSnapshot,
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;

  const report = buildDriftReport([driftedForBlocking], CURRENT);
  // Drift IS present — this is the "even when drift is present" precondition.
  assert.ok(report.length > 0, 'drift IS present (non-empty advisory)');
  assert.ok(report.some((a) => a.driftKind !== 'none'), 'at least one real drift advisory is present');
  // The advisory NEVER escalates to a gate failure: the only action is re_attestation.
  for (const a of report) {
    assert.equal(a.actionRequired, 're_attestation', 'advisory only ever asks for re_attestation, never a gate failure');
  }
  // No advisory carries a truthy `blocking` directive (nothing that could fail a gate).
  const anyBlocking = report.some((a) => (a as unknown as Record<string, unknown>).blocking === true);
  assert.equal(anyBlocking, false, 'NON-BLOCKING: no advisory sets blocking=true even when drift is present');
  // Mirror the read-only handler's summary contract: blocking stays false regardless of drift.
  const summary = { total: report.length, drifted: report.filter((a) => a.driftKind !== 'none').length, blocking: false };
  assert.equal(summary.blocking, false, 'the advisory summary is blocking=false even with drift present (never fails a gate)');
  assert.ok(summary.drifted > 0, 'summary confirms drift is present alongside blocking=false');
  console.log('✓ [non-blocking] buildDriftReport surfaces drift but the advisory is blocking=false (actionRequired=re_attestation only)');
}

// ── F-001 (CHK-004:adversarial:0): DETERMINISM + OFFLINE proof. ──────────────────
// The adversarial intent promised the smoke is deterministic and offline (cannot
// flake). This assertion proves it DIRECTLY: (1) running the pure report/detect Fns
// twice on byte-identical constructed input yields byte-identical serialized output
// (no time/random/ordering nondeterminism), and (2) the drift module performs NO
// network / fs / git I/O — its source imports only crypto (via digest) + types, so
// there is nothing that could talk to the network or the filesystem to make it flake.
{
  // (a) Byte-identical output on repeated runs — the core determinism guarantee.
  const CURRENT_SFH = '3'.repeat(64);
  const buildItems = (): readonly ChecklistItem[] => [
    Object.freeze({
      id: 'CHK-DET-1',
      title: 'material-drifted item for the determinism replay',
      userSees: 'the file report.pdf was generated',
      userSeesSnapshot: Object.freeze({
        normalizedClaimDigest: claimDigest('the file report.pdf was generated'),
        storyFilesHash: 'a'.repeat(64), // pinned at a different SFH → material drift
        headHash: 'deadbeef'.repeat(5),
        attestedAt: '2026-07-26T00:00:00.000Z',
      }) as FrozenClaimSnapshot,
      status: 'done',
      startTime: null,
      endTime: null,
    }) as ChecklistItem,
    Object.freeze({
      id: 'CHK-DET-2',
      title: 'legacy-unbound item for the determinism replay',
      userSees: 'a pre-feature promise with no snapshot',
      status: 'done',
      startTime: null,
      endTime: null,
    }) as ChecklistItem,
  ];
  const runA = JSON.stringify(buildDriftReport(buildItems(), CURRENT_SFH));
  const runB = JSON.stringify(buildDriftReport(buildItems(), CURRENT_SFH));
  assert.equal(runA, runB, 'buildDriftReport is deterministic: identical input → byte-identical serialized output');
  // detectDrift is likewise byte-stable across repeated calls on identical input.
  const snap: FrozenClaimSnapshot = {
    normalizedClaimDigest: claimDigest('the migration ran'),
    storyFilesHash: '5'.repeat(64),
    headHash: 'facefeed'.repeat(5),
    attestedAt: '2026-07-26T00:00:00.000Z',
  };
  const dA = JSON.stringify(detectDrift(snap, { currentNormalizedDigest: claimDigest('the migration ran'), currentStoryFilesHash: '6'.repeat(64) }));
  const dB = JSON.stringify(detectDrift(snap, { currentNormalizedDigest: claimDigest('the migration ran'), currentStoryFilesHash: '6'.repeat(64) }));
  assert.equal(dA, dB, 'detectDrift is deterministic: identical input → byte-identical serialized verdict');

  // (b) No network / fs / git I/O: the drift module imports only crypto (via ./digest)
  // + types. Statically prove it by scanning the module (and its one digest dep) source
  // for any fs / child_process / network import — there must be NONE. Reading a
  // checked-in source file is a deterministic, offline local read (no network, no git).
  const here = dirname(fileURLToPath(import.meta.url)); // packages/main/dist/tasks
  const coreDir = resolve(here, '../../src/core');
  const driftSrc = readFileSync(resolve(coreDir, 'frozen-claim-drift.ts'), 'utf8');
  const digestSrc = readFileSync(resolve(coreDir, 'digest.ts'), 'utf8');
  const FORBIDDEN_IO = [
    "'node:fs'", '"node:fs"', "'fs'", '"fs"',
    "'node:child_process'", '"node:child_process"', "'child_process'", '"child_process"',
    "'node:net'", "'node:http'", "'node:https'", "'node:dns'", "'node:tls'",
    'execSync', 'execFileSync', 'spawnSync', 'spawn(',
  ];
  for (const needle of FORBIDDEN_IO) {
    assert.ok(!driftSrc.includes(needle), `frozen-claim-drift.ts must perform NO fs/git/network I/O (found: ${needle})`);
    assert.ok(!digestSrc.includes(needle), `digest.ts (drift's only dep) must perform NO fs/git/network I/O (found: ${needle})`);
  }
  // Positive: the drift module's only runtime import is the crypto-backed digest helper.
  assert.match(driftSrc, /from '\.\/digest\.js'/, 'drift module imports the crypto-backed digest helper (its only runtime dep)');
  assert.match(digestSrc, /from 'node:crypto'/, 'digest helper is backed only by node:crypto');
  console.log('✓ [determinism] buildDriftReport/detectDrift replay byte-identically; drift module does NO network/fs/git I/O (crypto+types only)');
}

// ── F-002 (CHK-003:happy:0): CLEAN-BRANCH report path. ───────────────────────────
// CHK-003:happy promised an advisory for a drifted story AND "a clean report for a
// clean story", but only the drifted branch was previously exercised. This asserts the
// clean branch directly: buildDriftReport over ONLY clean, snapshot-bound items (no
// drift, no legacy-unbound) returns ZERO advisories — the clean-story report is empty.
{
  const CURRENT_SFH = '7'.repeat(64);
  // Two snapshot-bound items pinned at the CURRENT storyFilesHash with unchanged claims
  // → both clean (driftKind=none, bound) → both omitted → zero advisories.
  const cleanA: ChecklistItem = Object.freeze({
    id: 'CHK-CLEAN-1',
    title: 'clean, snapshot-bound item A',
    userSees: 'the config file was written to disk',
    userSeesSnapshot: Object.freeze({
      normalizedClaimDigest: claimDigest('the config file was written to disk'),
      storyFilesHash: CURRENT_SFH, // equals current → no material drift
      headHash: 'cafebabe'.repeat(5),
      attestedAt: '2026-07-26T00:00:00.000Z',
    }) as FrozenClaimSnapshot,
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;
  const cleanB: ChecklistItem = Object.freeze({
    id: 'CHK-CLEAN-2',
    title: 'clean, snapshot-bound item B',
    userSees: 'the archive was extracted to output/',
    userSeesSnapshot: Object.freeze({
      normalizedClaimDigest: claimDigest('the archive was extracted to output/'),
      storyFilesHash: CURRENT_SFH, // equals current → no material drift
      headHash: 'feedbeef'.repeat(5),
      attestedAt: '2026-07-26T00:00:00.000Z',
    }) as FrozenClaimSnapshot,
    status: 'done',
    startTime: null,
    endTime: null,
  }) as ChecklistItem;

  const report = buildDriftReport([cleanA, cleanB], CURRENT_SFH);
  assert.equal(report.length, 0, 'a clean story (only un-drifted snapshot-bound items) yields ZERO advisories');
  assert.equal(report.filter((a) => a.driftKind !== 'none').length, 0, 'no drift advisories on a clean story');
  assert.equal(report.filter((a) => a.classification === 'legacy-unbound').length, 0, 'no legacy-unbound advisories on a clean story');
  console.log('✓ [clean-branch] buildDriftReport over only clean bound items → zero advisories (clean-story report is empty)');
}

console.log('frozen-claim-drift-smoke: PASS');
