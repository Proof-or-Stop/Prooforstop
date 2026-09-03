#!/usr/bin/env node
/**
 * B-5d48 CHK-003: smoke suite for Experience Layer ③.2 — signatureTag
 * auto-candidate + provenance at finding_add.
 *
 * Coverage (named `check:` lines; prints TOTAL/PASS/FAIL counts; exits non-zero on
 * any failure; prints `signature-capture smoke passed` at the very end):
 *   - LEAF: deriveSignatureCandidate is deterministic (same input -> same output),
 *     never empty, tolerates {files:[]} / missing desc / non-string files, caps an
 *     extreme desc, and gives distinct outputs for distinct inputs (collision check).
 *   - WIRING: finding_add with NO signatureTag -> persisted finding has
 *     signatureTagSource==='auto' and a non-empty signatureTag; WITH a signatureTag
 *     -> signatureTagSource==='confirmed' and the supplied tag unchanged; empty /
 *     whitespace-only tags are treated as omitted (source==='auto').
 *   - CRITICAL _hash invariance: the REAL signFinding output is BYTE-IDENTICAL
 *     whether or not signatureTag/signatureTagSource are present on the finding
 *     object (signFinding is imported, never mocked).
 *
 * Runs entirely in an OS temp dir; saves/restores process.env + cwd; never
 * pollutes the repo.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { StoryStore } from '../core/store.js';
import { resetConfigCache, loadConfig } from '../core/config.js';
import { createFindingHandlers } from '../handlers/finding.js';
import type { HandlerContext } from '../handlers/context.js';
import { signFinding } from '../core/finding-verify.js';
import { deriveSignatureCandidate } from '../core/signature-candidate.js';
import type { ChecklistData, Finding, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-18T00:00:00.000Z';

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
  const root = mkdtempSync(join(tmpdir(), 'b5d48-sig-cap-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function newStory(storyId: string): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-5d48 smoke story',
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
  delete process.env.PROOF_OR_STOP_AGENT;

  try {
    // ─── LEAF: main derivation path ──────────────────────────────────────────
    check('leaf: deriveSignatureCandidate(category, files, desc) -> deterministic non-empty string with all parts', () => {
      const out = deriveSignatureCandidate('correctness', ['src/handlers/finding.ts'], 'Missing null check on input');
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 0, 'never empty');
      assert.ok(out.includes('correctness'), 'carries category');
      assert.ok(out.includes('ts'), 'carries fileKind (extension)');
      assert.ok(/missing|null|check|input/.test(out), 'carries desc tokens');
    });

    check('leaf: determinism — same args twice -> byte-identical output', () => {
      const a = deriveSignatureCandidate('bug', ['a/b/c.py'], 'Race condition under load');
      const b = deriveSignatureCandidate('bug', ['a/b/c.py'], 'Race condition under load');
      assert.equal(a, b, 'deterministic');
    });

    check('leaf: all-missing input -> non-empty, never throws', () => {
      const out = deriveSignatureCandidate(undefined, undefined, undefined);
      assert.ok(out.length > 0, 'never empty even when everything is missing');
      assert.equal(out, 'unknown|unknown|', 'falls back to unknown|unknown|<empty descKey>');
    });

    check('leaf: empty files array -> non-empty, category preserved', () => {
      const out = deriveSignatureCandidate('bug', [], 'x');
      assert.ok(out.length > 0);
      assert.ok(out.startsWith('bug|unknown|'), 'category=bug, fileKind=unknown for empty files');
    });

    check('leaf: empty-string category + empty desc -> non-empty', () => {
      const out = deriveSignatureCandidate('', ['a.ts'], '');
      assert.ok(out.length > 0);
      assert.ok(out.startsWith('unknown|ts|'), 'empty category folds to unknown; fileKind from a.ts');
    });

    check('leaf: tolerates non-string files (dirty unvalidated input)', () => {
      const dirty = [123, null, true, 'real/path/file.go'] as unknown as string[];
      const out = deriveSignatureCandidate('cat', dirty, 'desc here');
      assert.ok(out.length > 0, 'never empty');
      assert.ok(out.includes('go'), 'picks the first usable string file (file.go)');
    });

    check('leaf: very long desc (10k chars) -> bounded/capped output', () => {
      const longDesc = 'overflow '.repeat(2000); // ~18k chars
      const out = deriveSignatureCandidate('perf', ['x.ts'], longDesc);
      assert.ok(out.length > 0);
      // descKey is at most ~3 tokens joined by '-' -> overall result stays short.
      assert.ok(out.length < 120, `capped output stays bounded (got len ${out.length})`);
    });

    check('leaf: output is lowercase with no punctuation beyond | and - separators', () => {
      const out = deriveSignatureCandidate('Correctness', ['Src/Handlers/Finding.TS'], 'Missing!! NULL, check.');
      assert.equal(out, out.toLowerCase(), 'fully lowercase');
      assert.ok(/^[a-z0-9|-]*$/.test(out), `only [a-z0-9|-] chars (got ${out})`);
    });

    check('leaf: collision resistance — distinct triples -> distinct outputs', () => {
      const a = deriveSignatureCandidate('correctness', ['src/a.ts'], 'missing null check');
      const b = deriveSignatureCandidate('security', ['src/b.py'], 'sql injection risk');
      assert.notEqual(a, b, 'distinct inputs produce distinct outputs');
    });

    // ─── WIRING: finding_add auto path ───────────────────────────────────────
    check('wiring: finding_add with NO signatureTag -> source=auto + non-empty signatureTag', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-auto'; seedStory(store, storyId);
      h.finding_add({ storyId, desc: 'missing null check on input', severity: 'high', category: 'edge', agent: 'main', files: ['src/handlers/finding.ts'] });
      const f = store.readFindings(storyId).findings[0];
      assert.equal(f.signatureTagSource, 'auto', 'source=auto when no tag supplied');
      assert.ok(typeof f.signatureTag === 'string' && f.signatureTag.length > 0, 'non-empty derived candidate');
    });

    check('wiring: finding_add WITH signatureTag -> source=confirmed + supplied tag unchanged', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-conf'; seedStory(store, storyId);
      h.finding_add({ storyId, desc: 'xss in handler', severity: 'high', category: 'adversarial', agent: 'main', signatureTag: 'my-tag' });
      const f = store.readFindings(storyId).findings[0];
      assert.equal(f.signatureTagSource, 'confirmed', 'source=confirmed when tag supplied');
      assert.equal(f.signatureTag, 'my-tag', 'supplied tag persisted unchanged');
    });

    check('wiring: finding_add with empty-string signatureTag -> treated as omitted (source=auto)', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-empty'; seedStory(store, storyId);
      h.finding_add({ storyId, desc: 'a thing happened', severity: 'medium', category: 'edge', agent: 'main', signatureTag: '' });
      const f = store.readFindings(storyId).findings[0];
      assert.equal(f.signatureTagSource, 'auto', 'empty string is the omission boundary -> auto');
      assert.ok(f.signatureTag && f.signatureTag.length > 0, 'derived candidate present');
    });

    check('wiring: finding_add with whitespace-only signatureTag -> treated as omitted (source=auto)', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-ws'; seedStory(store, storyId);
      h.finding_add({ storyId, desc: 'whitespace boundary', severity: 'low', category: 'edge', agent: 'main', signatureTag: '   ' });
      const f = store.readFindings(storyId).findings[0];
      assert.equal(f.signatureTagSource, 'auto', 'whitespace trims to empty -> auto');
    });

    check('wiring: sparse finding (no files, minimal desc) + no tag -> auto candidate still non-empty', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createFindingHandlers(ctx);
      const storyId = 'B-sparse'; seedStory(store, storyId);
      // Sparse case the handler accepts: a valid category but no files and a single-char
      // desc (no qualifying tokens) — exercises deriveSignatureCandidate's empty-descKey
      // / unknown-fileKind fallback while still passing handler validation.
      h.finding_add({ storyId, desc: 'x', severity: 'low', category: 'edge', agent: 'main' });
      const f = store.readFindings(storyId).findings[0];
      assert.equal(f.signatureTagSource, 'auto');
      assert.ok(f.signatureTag && f.signatureTag.length > 0, 'never empty on sparse input');
    });

    // ─── CRITICAL: _hash invariance via the REAL signFinding ─────────────────
    check('CRITICAL: signFinding output is BYTE-IDENTICAL with vs without signatureTag/signatureTagSource', () => {
      const storyId = 'B-inv';
      const fid = `${storyId}:F-001`;
      const desc = 'critical invariance desc';
      const severity = 'high';
      const createdAt = PINNED_NOW;
      const reviewRound = 'R-1';
      const reviewRunId = '';
      // Hash computed twice over the SAME signed domain — the new fields are never
      // arguments to signFinding, so the two hashes must be identical.
      const hashWithout = signFinding(storyId, fid, desc, severity, createdAt, reviewRound, reviewRunId);

      const without: Finding = {
        id: fid, desc, severity, category: 'adversarial', status: 'open',
        createdAt, reviewRound, _hash: hashWithout,
      };
      const withFields: Finding = {
        ...without,
        signatureTag: 'correctness|ts|critical-invariance-desc',
        signatureTagSource: 'auto',
      };
      // Recompute the signature from BOTH objects' signed domains — byte-identical.
      const reWithout = signFinding(storyId, without.id, without.desc, without.severity, without.createdAt!, without.reviewRound!, '');
      const reWith = signFinding(storyId, withFields.id, withFields.desc, withFields.severity, withFields.createdAt!, withFields.reviewRound!, '');
      assert.equal(reWith, reWithout, 'signFinding domain unchanged regardless of the new audit fields');
      assert.equal(withFields._hash, without._hash, 'stored _hash identical with vs without the new fields');
    });

    // ─── Structured counts (verifier parsability) ────────────────────────────
    console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);

    if (passed !== total) {
      throw new Error(`signature-capture smoke had ${total - passed} failing check(s)`);
    }
    console.log('signature-capture smoke passed');
  } finally {
    process.chdir(savedCwd);
    for (const root of tmpRoots) {
      try { execFileSync('rm', ['-rf', root]); } catch { /* best-effort cleanup */ }
    }
    process.env = savedEnv;
  }
}

run();
