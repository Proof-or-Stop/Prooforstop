#!/usr/bin/env node
/**
 * B-4f46 CHK-004: smoke suite for Experience Layer Phase 1b — finding outcome
 * enums + signatureTag + signature-registry.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `smoke passed` at the very end):
 *   - CAPTURE: finding_add/resolve/dismiss capture + persist the optional audit
 *     fields; field-less calls behave EXACTLY as before (back-compat); invalid
 *     enum values are rejected with a clear error.
 *   - LEGACY: a finding with none of the new fields still verifies (finding-verify
 *     unchanged); its signature is byte-identical to the pre-change signFinding for
 *     the same legacy input.
 *   - GUARDRAIL (load-bearing): the advisory gate decision (isFindingBlocking) is
 *     IDENTICAL for a finding WITH audit fields vs WITHOUT them; a grep proves
 *     advisory.ts references none of the audit field names.
 *   - SIGNATURE-REGISTRY: auto-propose on finding_add of a new tag;
 *     signature_registry_set approve -> active; alias/mergedInto fold a synonym to
 *     the canonical via resolveTag.
 *   - ENRICHMENT: deriveFindingSignals with resolutionType='fixed' yields
 *     signalScore > 0 (vs 0 without the enums).
 *   - NO REGRESSION: the existing finding-related signature stays stable and the
 *     Phase 1a finding-signals smoke still passes (invoked as a subprocess).
 *
 * Runs entirely in an OS temp dir; saves/restores process.env + cwd; never
 * pollutes the repo.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { resetConfigCache, loadConfig } from '../core/config.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { createSignatureRegistryHandlers } from '../handlers/signature-registry.js';
import type { HandlerContext } from '../handlers/context.js';
import { signFinding, verifyFinding } from '../core/finding-verify.js';
import { isFindingBlocking } from '../core/advisory.js';
import { deriveFindingSignals } from '../core/finding-signals.js';
import {
  listSignatureTags,
  resolveTag,
  readSignatureRegistry,
} from '../core/learning-store.js';
import type { ChecklistData, Finding, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-17T00:00:00.000Z';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const REPO_ROOT = repoRoot();

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

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'b4f46-exp-1b-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function newStory(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-4f46 smoke story',
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

/** Build a HandlerContext bound to a hermetic temp project root. */
function mkCtx(root: string): { ctx: HandlerContext; store: StoryStore } {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, config.scanRoot), log: () => {} };
  return { ctx, store };
}

/** Seed one story in the store, ready for finding handlers (agent='main' path). */
function seedStory(store: StoryStore, storyId: string): void {
  store.writeStory(storyId, newStory(storyId));
  store.writeChecklist(storyId, emptyChecklist());
  store.writeFindings(storyId, { findings: [] });
}

function run(): void {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const tmpRoots: string[] = [];
  // agent='main' avoids the reviewer review-run binding requirement entirely.
  delete process.env.LATTICE_AGENT;

  try {
    // ─── CAPTURE: finding_add persists signatureTag ───────────────────────────
    check('capture: finding_add with signatureTag persists the field', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-cap1'; seedStory(store, storyId);
      h.finding_add({ storyId, desc: 'xss in handler', severity: 'high', category: 'adversarial', agent: 'main', signatureTag: 'auth-bypass' });
      const fs = store.readFindings(storyId).findings;
      assert.equal(fs.length, 1);
      assert.equal(fs[0].signatureTag, 'auth-bypass', 'signatureTag persisted');
    });

    // ─── CAPTURE: finding_resolve persists resolutionType + strength ───────────
    check('capture: finding_resolve persists resolutionType + resolveEvidenceStrength', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-cap2'; seedStory(store, storyId);
      const msg = h.finding_add({ storyId, desc: 'a leak somewhere', severity: 'medium', category: 'edge', agent: 'main' });
      const fid = msg.match(/Finding (\S+) created/)![1];
      h.finding_resolve({ storyId, findingId: fid, resolution: 'patched', resolutionType: 'fixed', resolveEvidenceStrength: 'strong' });
      const f = store.readFindings(storyId).findings.find(x => x.id === fid)!;
      assert.equal(f.status, 'resolved');
      assert.equal(f.resolutionType, 'fixed');
      assert.equal(f.resolveEvidenceStrength, 'strong');
    });

    // ─── CAPTURE: finding_dismiss persists dismissReasonType + strength ────────
    check('capture: finding_dismiss persists dismissReasonType + dismissEvidenceStrength', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-cap3'; seedStory(store, storyId);
      const fid = h.finding_add({ storyId, desc: 'maybe wrong', severity: 'low', category: 'edge', agent: 'main' }).match(/Finding (\S+) created/)![1];
      h.finding_dismiss({ storyId, findingId: fid, reason: 'not actually exploitable here', dismissReasonType: 'false_positive', dismissEvidenceStrength: 'medium' });
      const f = store.readFindings(storyId).findings.find(x => x.id === fid)!;
      assert.equal(f.status, 'dismissed');
      assert.equal(f.dismissReasonType, 'false_positive');
      assert.equal(f.dismissEvidenceStrength, 'medium');
    });

    // ─── BACK-COMPAT: field-less calls behave exactly as before ────────────────
    check('back-compat: field-less add/resolve/dismiss leave audit fields undefined', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-bc'; seedStory(store, storyId);
      // add (no signatureTag)
      const addId = h.finding_add({ storyId, desc: 'legacy add', severity: 'medium', category: 'edge', agent: 'main' }).match(/Finding (\S+) created/)![1];
      const added = store.readFindings(storyId).findings.find(x => x.id === addId)!;
      assert.equal(added.signatureTag, undefined, 'no signatureTag when omitted');
      // resolve (no enums)
      h.finding_resolve({ storyId, findingId: addId });
      const resolved = store.readFindings(storyId).findings.find(x => x.id === addId)!;
      assert.equal(resolved.status, 'resolved');
      assert.equal(resolved.resolutionType, undefined, 'no resolutionType when omitted');
      assert.equal(resolved.resolveEvidenceStrength, undefined);
      // dismiss with NO dismissReasonType (proves it is truly OPTIONAL)
      const dId = h.finding_add({ storyId, desc: 'legacy dismiss', severity: 'low', category: 'edge', agent: 'main' }).match(/Finding (\S+) created/)![1];
      const dMsg = h.finding_dismiss({ storyId, findingId: dId, reason: 'will not fix this one' });
      assert.match(dMsg, /dismissed/);
      const dismissed = store.readFindings(storyId).findings.find(x => x.id === dId)!;
      assert.equal(dismissed.status, 'dismissed');
      assert.equal(dismissed.dismissReasonType, undefined, 'dismissReasonType truly optional');
      assert.equal(dismissed.dismissEvidenceStrength, undefined);
    });

    // ─── VALIDATION: invalid enum value rejected with a clear error ────────────
    check('validation: invalid enum values are rejected with a clear error', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-val'; seedStory(store, storyId);
      const fid = h.finding_add({ storyId, desc: 'thing', severity: 'medium', category: 'edge', agent: 'main' }).match(/Finding (\S+) created/)![1];
      assert.throws(
        () => h.finding_resolve({ storyId, findingId: fid, resolutionType: 'bogus' as unknown as string }),
        /resolutionType must be one of/,
      );
      const fid2 = h.finding_add({ storyId, desc: 'thing2', severity: 'low', category: 'edge', agent: 'main' }).match(/Finding (\S+) created/)![1];
      assert.throws(
        () => h.finding_dismiss({ storyId, findingId: fid2, reason: 'enough characters here', dismissReasonType: 'nope' as unknown as string }),
        /dismissReasonType must be one of/,
      );
      assert.throws(
        () => h.finding_resolve({ storyId, findingId: fid, resolveEvidenceStrength: 'super' as unknown as string }),
        /resolveEvidenceStrength must be one of/,
      );
    });

    // ─── LEGACY: finding-verify unchanged; signature byte-identical ────────────
    check('legacy: finding-verify verifies a legacy finding; signature byte-identical to pre-change signFinding', () => {
      // A legacy finding (none of the Phase-1b fields). Its signature is produced
      // by signFinding over the SAME domain it always used — adding audit fields
      // to the object must not change the hash.
      const storyId = 'B-leg';
      const fid = `${storyId}:F-001`;
      const desc = 'legacy desc';
      const severity = 'high';
      const createdAt = PINNED_NOW;
      const reviewRound = 'R-1';
      const expected = signFinding(storyId, fid, desc, severity, createdAt, reviewRound, '');
      const legacy: Finding = {
        id: fid, desc, severity, category: 'adversarial', status: 'open',
        createdAt, reviewRound, _hash: expected,
      };
      assert.ok(verifyFinding(storyId, legacy), 'legacy finding verifies');
      // Now the SAME finding object carrying audit fields — same _hash must verify.
      const withAudit: Finding = {
        ...legacy,
        signatureTag: 'auth-bypass',
        resolutionType: 'fixed',
        dismissReasonType: 'false_positive',
        resolveEvidenceStrength: 'strong',
        dismissEvidenceStrength: 'weak',
      };
      assert.equal(withAudit._hash, expected, 'audit fields do not change the stored hash');
      assert.ok(verifyFinding(storyId, withAudit), 'audit-laden finding still verifies (audit fields excluded from signature)');
      // Recompute the signature from the audit-laden object's signed domain — identical.
      const recomputed = signFinding(storyId, withAudit.id, withAudit.desc, withAudit.severity, withAudit.createdAt!, withAudit.reviewRound!, '');
      assert.equal(recomputed, expected, 'signFinding domain unchanged — byte-identical');
    });

    // ─── GUARDRAIL: advisory gate decision identical with vs without audit ─────
    check('guardrail: isFindingBlocking IDENTICAL with vs without audit fields (advisory ignores them)', () => {
      const base = { status: 'open' as const, severity: 'high' as const, evidenceState: 'verified' as const };
      const blocking = ['critical', 'high'] as const;
      for (const round of [1, 2, 3]) {
        const without = isFindingBlocking(base, blocking, round);
        const withAudit = isFindingBlocking({
          ...base,
          // these fields are NOT in the Pick<> the gate accepts; cast to prove the
          // gate's decision cannot depend on them even when present at runtime.
          ...( { signatureTag: 'x', resolutionType: 'fixed', dismissReasonType: 'false_positive', resolveEvidenceStrength: 'strong', dismissEvidenceStrength: 'weak' } as Record<string, unknown> ),
        } as typeof base, blocking, round);
        assert.equal(withAudit, without, `round ${round}: audit fields must not change the gate decision`);
      }
    });

    // ─── GUARDRAIL (static): advisory.ts references no audit field name ─────────
    check('guardrail: advisory.ts contains no reference to any audit field name', () => {
      const src = readFileSync(join(REPO_ROOT, 'packages/main/src/core/advisory.ts'), 'utf-8');
      for (const needle of ['signatureTag', 'resolutionType', 'dismissReasonType', 'evidenceStrength']) {
        assert.ok(!src.includes(needle), `advisory.ts must not reference ${needle}`);
      }
    });

    // ─── SIGNATURE-REGISTRY: auto-propose on finding_add of a new tag ──────────
    check('signature-registry: finding_add of a new signatureTag auto-proposes it', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-reg1'; seedStory(store, storyId);
      assert.equal(listSignatureTags(root).length, 0, 'registry starts empty');
      h.finding_add({ storyId, desc: 'sqli', severity: 'high', category: 'adversarial', agent: 'main', signatureTag: 'sql-injection' });
      const tags = listSignatureTags(root);
      assert.equal(tags.length, 1);
      assert.equal(tags[0].tag, 'sql-injection');
      assert.equal(tags[0].status, 'proposed', 'auto-recorded as proposed');
      // A second finding with the same tag does not duplicate it.
      h.finding_add({ storyId, desc: 'sqli again', severity: 'high', category: 'adversarial', agent: 'main', signatureTag: 'sql-injection' });
      assert.equal(listSignatureTags(root).length, 1, 'no duplicate proposal');
    });

    // ─── SIGNATURE-REGISTRY: approve flips proposed -> active ──────────────────
    check('signature-registry: signature_registry_set approve flips proposed -> active', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx } = mkCtx(root);
      const sr = createSignatureRegistryHandlers(ctx);
      sr.signature_registry_set({ tag: 'xss', action: 'propose', by: 'tester' });
      assert.equal(readSignatureRegistry(root).tags.find(t => t.tag === 'xss')!.status, 'proposed');
      sr.signature_registry_set({ tag: 'xss', action: 'approve', by: 'tester' });
      const entry = readSignatureRegistry(root).tags.find(t => t.tag === 'xss')!;
      assert.equal(entry.status, 'active', 'approve => active');
      assert.equal(entry.approvedBy, 'tester');
    });

    // ─── SIGNATURE-REGISTRY: alias + mergedInto fold a synonym via resolveTag ──
    check('signature-registry: alias + mergedInto fold a synonym to the canonical via resolveTag', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx } = mkCtx(root);
      const sr = createSignatureRegistryHandlers(ctx);
      // canonical active tag + alias synonym
      sr.signature_registry_set({ tag: 'auth-bypass', action: 'approve', by: 'tester' });
      sr.signature_registry_set({ tag: 'auth-bypass', action: 'alias', alias: 'authbypass' });
      assert.equal(resolveTag(root, 'authbypass'), 'auth-bypass', 'alias folds to canonical');
      assert.equal(resolveTag(root, 'auth-bypass'), 'auth-bypass', 'canonical resolves to itself');
      // deprecate a synonym tag, merging into the canonical
      sr.signature_registry_set({ tag: 'auth-bypass-old', action: 'deprecate', mergedInto: 'auth-bypass' });
      assert.equal(resolveTag(root, 'auth-bypass-old'), 'auth-bypass', 'mergedInto folds to canonical');
    });

    // ─── ENRICHMENT: enums make finding-signals signalScore > 0 ────────────────
    check('enrichment: resolutionType=fixed yields signalScore > 0 (vs 0 without enums)', () => {
      const withoutEnums = deriveFindingSignals([
        { category: 'adversarial', signatureTag: 'xss', status: 'resolved', files: ['a.ts'] },
      ], { now: PINNED_NOW });
      assert.equal(withoutEnums.signals[0].signalScore, 0, 'no enums => conservative 0');

      const withEnums = deriveFindingSignals([
        { category: 'adversarial', signatureTag: 'xss', status: 'resolved', resolutionType: 'fixed', files: ['a.ts'] },
      ], { now: PINNED_NOW });
      assert.ok(withEnums.signals[0].signalScore > 0, `enums => signalScore > 0, got ${withEnums.signals[0].signalScore}`);
      assert.equal(withEnums.signals[0].signalScore, 0.5, 'single fixed => 1/(1+0+1) = 0.5');
    });

    // ─── NO REGRESSION: registry cache file lives only under .lattice/learning/ ─
    check('no-regression: signature-registry persisted under .lattice/learning/ only', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx } = mkCtx(root);
      const sr = createSignatureRegistryHandlers(ctx);
      sr.signature_registry_set({ tag: 'probe', action: 'propose', by: 'tester' });
      assert.ok(existsSync(join(root, '.lattice/learning/signature-registry.json')), 'written under .lattice/learning/');
    });
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
    for (const r of tmpRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }

  // ─── NO REGRESSION: the Phase 1a finding-signals smoke still passes ──────────
  check('no-regression: Phase 1a finding-signals smoke still passes', () => {
    const out = execFileSync('node', ['dist/tasks/experience-layer-finding-signals-smoke.js'], {
      cwd: join(REPO_ROOT, 'packages', 'main'),
      encoding: 'utf-8',
    });
    assert.match(out, /smoke passed/, 'Phase 1a smoke prints "smoke passed"');
  });

  console.log(`\nTOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (process.exitCode === 1) {
    console.error('smoke FAILED');
    return;
  }
  console.log('smoke passed');
}

run();
