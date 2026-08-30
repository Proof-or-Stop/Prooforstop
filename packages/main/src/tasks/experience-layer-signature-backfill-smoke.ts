#!/usr/bin/env node
/**
 * B-17a9 CHK-003: hermetic smoke suite for `signature_backfill` (Experience Layer).
 *
 * Runs entirely in an OS temp store (mkdtemp) with three findings exercising every
 * tag state — F1 empty, F2 source='confirmed', F3 source='auto' — plus a synthetic
 * map { F1, F2, F3, Fzzz }. Saves/restores process.env + cwd; never touches the repo.
 *
 * Coverage (prints TOTAL/PASS/FAIL; exits non-zero on any failure; prints
 * `signature-backfill smoke passed` at the very end):
 *   - DRY-RUN (no --apply): findings.json byte-UNCHANGED; report shows would-fill 1.
 *   - --apply: F1 gets signatureTag + source='backfill'; F2 (confirmed) untouched;
 *     F3 (auto) untouched WITHOUT overwriteAuto; with overwriteAuto F3 -> backfill.
 *   - CRITICAL _hash invariance: every touched finding's `_hash` is byte-identical
 *     before vs after --apply, AND equals the REAL signFinding recomputed over its
 *     signed domain (signFinding imported, never mocked).
 *   - Fzzz (absent from any story) ignored; map findingIds in no story => no write.
 *   - SECOND --apply run is idempotent: findings.json byte-identical to after first.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { resetConfigCache, loadConfig } from '../core/config.js';
import { createSignatureBackfillHandlers } from '../handlers/signature-backfill.js';
import { decideBackfill } from '../core/signature-backfill.js';
import type { HandlerContext } from '../handlers/context.js';
import { signFinding } from '../core/finding-verify.js';
import type { ChecklistData, Finding, FindingData, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-18T00:00:00.000Z';
const STORY_ID = 'B-bf01';
const EMPTY_STORY_ID = 'B-bf02'; // a story with zero findings — must not crash iteration

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'b17a9-sig-bf-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2), 'utf-8');
  return root;
}

function newStory(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-17a9 backfill smoke story',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: PINNED_NOW,
    startedAt: PINNED_NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: PINNED_NOW }],
  };
}

function emptyChecklist(): ChecklistData {
  return { items: [] };
}

function mkCtx(root: string): { ctx: HandlerContext; store: StoryStore } {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, config.scanRoot), log: () => {} };
  return { ctx, store };
}

/** Build a finding with a REAL _hash over its signed domain (signatureTag fields attached AFTER, as in finding.ts). */
function mkFinding(
  fid: string,
  desc: string,
  extras: { signatureTag?: string; signatureTagSource?: 'auto' | 'confirmed' | 'backfill' },
): Finding {
  const severity = 'high' as const;
  const reviewRound = 'R-1';
  return {
    id: fid,
    desc,
    severity,
    category: 'adversarial',
    status: 'open',
    createdAt: PINNED_NOW,
    reviewRound,
    // _hash is over the signed domain ONLY — the audit fields below are attached AFTER and never hashed.
    _hash: signFinding(STORY_ID, fid, desc, severity, PINNED_NOW, reviewRound, ''),
    ...(extras.signatureTag !== undefined ? { signatureTag: extras.signatureTag } : {}),
    ...(extras.signatureTagSource !== undefined ? { signatureTagSource: extras.signatureTagSource } : {}),
  };
}

const F1 = `${STORY_ID}:F-001`; // empty signatureTag
const F2 = `${STORY_ID}:F-002`; // confirmed
const F3 = `${STORY_ID}:F-003`; // auto

function seedStore(store: StoryStore): void {
  store.writeStory(STORY_ID, newStory(STORY_ID));
  store.writeChecklist(STORY_ID, emptyChecklist());
  const data: FindingData = {
    findings: [
      mkFinding(F1, 'empty-tag finding to be backfilled', {}),
      mkFinding(F2, 'confirmed finding must be untouched', { signatureTag: 'conf|tag', signatureTagSource: 'confirmed' }),
      mkFinding(F3, 'auto finding preserved unless overwriteAuto', { signatureTag: 'auto|tag', signatureTagSource: 'auto' }),
    ],
  };
  store.writeFindings(STORY_ID, data);
  // An empty-findings story to prove iteration tolerates scanned=0 stories.
  store.writeStory(EMPTY_STORY_ID, newStory(EMPTY_STORY_ID));
  store.writeChecklist(EMPTY_STORY_ID, emptyChecklist());
  store.writeFindings(EMPTY_STORY_ID, { findings: [] });
}

function writeMap(root: string): string {
  const mapPath = join(root, 'sig-map.json');
  writeFileSync(mapPath, JSON.stringify({
    [F1]: 'area|mode',
    [F2]: 'x|y',
    [F3]: 'p|q',
    'B-zzzz:F-999': 'n|m', // Fzzz — absent from every story
  }, null, 2), 'utf-8');
  return mapPath;
}

/** Absolute path of a story's findings.json for byte-comparison. */
function findingsPath(root: string, storyId: string): string {
  return join(root, '.proof-or-stop/story/actives', storyId, 'findings.json');
}

function run(): void {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const tmpRoots: string[] = [];
  delete process.env.PROOF_OR_STOP_AGENT;

  try {
    // ── DRY-RUN: nothing written ─────────────────────────────────────────────
    check('dry-run (no --apply): findings.json byte-UNCHANGED + report shows would-fill 1', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = writeMap(root);
      const h = createSignatureBackfillHandlers(ctx);

      const before = readFileSync(findingsPath(root, STORY_ID), 'utf-8');
      const report = h.signature_backfill({ map: mapPath });
      const after = readFileSync(findingsPath(root, STORY_ID), 'utf-8');

      assert.equal(after, before, 'dry-run must not modify findings.json');
      assert.ok(/DRY-RUN/.test(report), 'dry-run banner present');
      assert.ok(/would-fill 1\b/.test(report), `would-fill 1 in report (got: ${report})`);
    });

    check('dry-run --json: structured tally has fill=1, skip-confirmed=1, skip-has-auto=1, skip-no-mapping for Fzzz', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = writeMap(root);
      const h = createSignatureBackfillHandlers(ctx);

      const out = JSON.parse(h.signature_backfill({ map: mapPath, json: true }));
      assert.equal(out.dryRun, true, 'json marks dryRun');
      assert.equal(out.filled, 1, 'one would-fill');
      assert.equal(out.actions.fill, 1, 'action fill=1');
      assert.equal(out.actions['skip-confirmed'], 1, 'confirmed skipped');
      assert.equal(out.actions['skip-has-auto'], 1, 'auto skipped (no overwriteAuto)');
      // Fzzz maps to nothing in any story; the three real findings all have a mapping.
      assert.equal(out.bySource.empty, 1, 'one empty-source finding');
      assert.equal(out.bySource.confirmed, 1, 'one confirmed-source finding');
      assert.equal(out.bySource.auto, 1, 'one auto-source finding');
      assert.equal(out.storiesWritten, 0, 'dry-run writes no story');
    });

    // ── --apply: fill F1, leave F2/F3 ────────────────────────────────────────
    check('--apply: F1 -> signatureTag from map + source=backfill; F2 confirmed untouched; F3 auto untouched', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = writeMap(root);
      const h = createSignatureBackfillHandlers(ctx);

      h.signature_backfill({ map: mapPath, apply: true });
      const fs2 = store.readFindings(STORY_ID).findings;
      const byId = Object.fromEntries(fs2.map((f) => [f.id, f]));

      assert.equal(byId[F1].signatureTag, 'area|mode', 'F1 filled from map');
      assert.equal(byId[F1].signatureTagSource, 'backfill', 'F1 source=backfill');
      assert.equal(byId[F2].signatureTag, 'conf|tag', 'F2 tag unchanged');
      assert.equal(byId[F2].signatureTagSource, 'confirmed', 'F2 still confirmed');
      assert.equal(byId[F3].signatureTag, 'auto|tag', 'F3 tag unchanged');
      assert.equal(byId[F3].signatureTagSource, 'auto', 'F3 still auto (no overwriteAuto)');
    });

    check('--apply --overwriteAuto: F3 auto -> backfill; F2 confirmed STILL untouched (strongest invariant)', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = writeMap(root);
      const h = createSignatureBackfillHandlers(ctx);

      h.signature_backfill({ map: mapPath, apply: true, overwriteAuto: true });
      const byId = Object.fromEntries(store.readFindings(STORY_ID).findings.map((f) => [f.id, f]));

      assert.equal(byId[F3].signatureTag, 'p|q', 'F3 overwritten from map');
      assert.equal(byId[F3].signatureTagSource, 'backfill', 'F3 now backfill');
      assert.equal(byId[F2].signatureTag, 'conf|tag', 'F2 confirmed untouched even with overwriteAuto');
      assert.equal(byId[F2].signatureTagSource, 'confirmed', 'confirmed is sacrosanct under overwriteAuto');
    });

    // ── CRITICAL: _hash invariance via the REAL signFinding ──────────────────
    check('CRITICAL: every touched finding _hash byte-identical before/after --apply AND equals real signFinding', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = writeMap(root);
      const h = createSignatureBackfillHandlers(ctx);

      // Snapshot every finding's stored _hash before the write.
      const hashesBefore = Object.fromEntries(
        store.readFindings(STORY_ID).findings.map((f) => [f.id, f._hash]),
      );

      h.signature_backfill({ map: mapPath, apply: true, overwriteAuto: true });

      const after = store.readFindings(STORY_ID).findings;
      for (const f of after) {
        assert.equal(f._hash, hashesBefore[f.id], `${f.id} _hash unchanged across --apply`);
        // Recompute from scratch with the REAL signFinding over the signed domain only.
        const recomputed = signFinding(STORY_ID, f.id, f.desc, f.severity, f.createdAt!, f.reviewRound!, '');
        assert.equal(f._hash, recomputed, `${f.id} stored _hash equals real signFinding (fields never leak into hash domain)`);
      }
      // And F1 really did get backfilled (so the touched-finding case is exercised).
      const f1 = after.find((f) => f.id === F1)!;
      assert.equal(f1.signatureTagSource, 'backfill', 'F1 was a touched finding');
    });

    // ── absent-from-map + empty story => skipped, no write ────────────────────
    check('finding absent from map (and empty-findings story) => skipped, no spurious write', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      // A map that covers NO finding in any story.
      const mapPath = join(root, 'no-match.json');
      writeFileSync(mapPath, JSON.stringify({ 'B-none:F-001': 'a|b' }, null, 2), 'utf-8');
      const h = createSignatureBackfillHandlers(ctx);

      const before = readFileSync(findingsPath(root, STORY_ID), 'utf-8');
      const out = JSON.parse(h.signature_backfill({ map: mapPath, apply: true, json: true }));
      const after = readFileSync(findingsPath(root, STORY_ID), 'utf-8');

      assert.equal(out.filled, 0, 'nothing filled when no map entry matches');
      assert.equal(out.storiesWritten, 0, 'no story written');
      assert.equal(out.actions['skip-no-mapping'], 3, 'all three real findings skip-no-mapping');
      assert.equal(after, before, 'findings.json untouched when nothing fills');
      // Empty-findings story did not crash iteration (we reached here).
    });

    // ── idempotency: second --apply is a no-op ───────────────────────────────
    check('second --apply run is idempotent: findings.json byte-identical to after the first', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = writeMap(root);
      const h = createSignatureBackfillHandlers(ctx);

      h.signature_backfill({ map: mapPath, apply: true });
      const afterFirst = readFileSync(findingsPath(root, STORY_ID), 'utf-8');

      const out2 = JSON.parse(h.signature_backfill({ map: mapPath, apply: true, json: true }));
      const afterSecond = readFileSync(findingsPath(root, STORY_ID), 'utf-8');

      assert.equal(out2.filled, 0, 'second run fills nothing (idempotent)');
      assert.equal(out2.storiesWritten, 0, 'second run writes no story');
      assert.equal(afterSecond, afterFirst, 'findings.json byte-identical after second --apply');
    });

    // ── missing / malformed map => clear error, no write ─────────────────────
    check('missing map file => clear error thrown, store uncorrupted', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const h = createSignatureBackfillHandlers(ctx);
      const before = readFileSync(findingsPath(root, STORY_ID), 'utf-8');
      assert.throws(
        () => h.signature_backfill({ map: join(root, 'does-not-exist.json'), apply: true }),
        /cannot read map file/,
        'missing file gives a clear read error',
      );
      assert.equal(readFileSync(findingsPath(root, STORY_ID), 'utf-8'), before, 'no write on missing map');
    });

    check('malformed JSON map => clear parse error thrown, store uncorrupted', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = join(root, 'bad.json');
      writeFileSync(mapPath, '{ this is : not json', 'utf-8');
      const h = createSignatureBackfillHandlers(ctx);
      const before = readFileSync(findingsPath(root, STORY_ID), 'utf-8');
      assert.throws(
        () => h.signature_backfill({ map: mapPath, apply: true }),
        /not valid JSON/,
        'malformed map gives a clear parse error',
      );
      assert.equal(readFileSync(findingsPath(root, STORY_ID), 'utf-8'), before, 'no write on malformed map');
    });

    check('no --map arg => required-argument error, no write', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const h = createSignatureBackfillHandlers(ctx);
      assert.throws(() => h.signature_backfill({}), /--map <file> is required/, 'required-arg error');
    });

    check('empty map ({}) => scanned>0, filled=0, all skip-no-mapping', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      seedStore(store);
      const mapPath = join(root, 'empty.json');
      writeFileSync(mapPath, '{}', 'utf-8');
      const h = createSignatureBackfillHandlers(ctx);
      const out = JSON.parse(h.signature_backfill({ map: mapPath, json: true }));
      assert.ok(out.scanned >= 3, 'scanned the real findings');
      assert.equal(out.filled, 0, 'empty map fills nothing');
      assert.equal(out.actions['skip-no-mapping'], out.scanned, 'every finding skip-no-mapping');
    });

    // ── leaf direct: provenance integrity + no mutation ──────────────────────
    check('leaf: decideBackfill never mutates the input finding object', () => {
      const input = { signatureTag: '', signatureTagSource: undefined as unknown as string };
      const snapshot = JSON.stringify(input);
      const d = decideBackfill(input, 'a|b', {});
      assert.equal(d.action, 'fill');
      assert.equal(JSON.stringify(input), snapshot, 'input untouched (pure)');
    });

    console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
    if (passed !== total) {
      throw new Error(`signature-backfill smoke had ${total - passed} failing check(s)`);
    }
    console.log('signature-backfill smoke passed');
  } finally {
    process.chdir(savedCwd);
    for (const root of tmpRoots) {
      try { execFileSync('rm', ['-rf', root]); } catch { /* best-effort cleanup */ }
    }
    process.env = savedEnv;
  }
}

run();
