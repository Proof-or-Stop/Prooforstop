#!/usr/bin/env node
/**
 * B-000c CHK-004: smoke suite for the Experience Layer Phase 1a finding-signals
 * derived cache.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `smoke passed` at the very end):
 *   - PURE derivation over seeded findings WITH the Phase-1b optional enums:
 *     correct localSignature grouping, counts, signalScore = positive/(pos+neg+1),
 *     support; partially_mitigated contributes 0.5.
 *   - EDGE: zero-sample => no NaN, empty signals; single-hit (one fixed) =>
 *     signalScore 0.5 with support 1; signatureTag absent => coarse grouping;
 *     malformed/missing-field findings tolerated (no throw).
 *   - learning-store round-trip + first-run dir creation + missing-file read =>
 *     null + malformed-JSON read => null.
 *   - ADAPTER deriveFindingSignalsFromStore: seed findings via the store, derive,
 *     assert the persisted cache matches — proving the store.readFindings port.
 *   - GATE-SAFETY: currentMaterialHash identical before/after writeFindingSignals
 *     and across overwrite/create-then-delete; learning-log path is excluded.
 *   - STATIC zero-outward-import scan over the three modules.
 *   - ADVERSARIAL: in-memory mutate the scan target to prove the static scan is
 *     not vacuously true.
 *
 * Runs entirely in an OS temp dir; saves/restores process.env; never pollutes
 * the repo.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  deriveFindingSignals,
  deriveFindingSignalsFromStore,
  FINDING_SIGNALS_SCHEMA_VERSION,
} from '../core/finding-signals.js';
import type { SignalSourceFinding } from '../core/experience-layer-types.js';
import {
  ensureLearningDir,
  readFindingSignals,
  resolveFindingSignalsPath,
  resolveLearningLogPath,
  writeFindingSignals,
} from '../core/learning-store.js';
import {
  findRuntimeArtifactEntry,
  isMaterialExcludedRuntimeArtifactPath,
  isVolatileRuntimeArtifactPath,
  isRepairableTrackedRuntimeArtifactPath,
} from '../core/runtime-artifact-registry.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-17T00:00:00.000Z';

/** Resolve `packages/main/src/core` via the repo root (robust under ESM). */
function repoCoreDir(): string {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  return join(repoRoot, 'packages', 'main', 'src', 'core');
}
const REPO_CORE = repoCoreDir();

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

function mkTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'b000c-exp-layer-'));
}

/** A git-backed temp project (needed for currentMaterialHash) with a base commit. */
function mkGitProject(): { root: string; baseHash: string } {
  const root = mkTempRoot();
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'B-000c Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=B-000c Smoke', 'commit', '-m', 'base']);
  const baseHash = git(root, ['rev-parse', 'HEAD']);
  return { root, baseHash };
}

function newStory(storyId: string): StoryInfo {
  const now = PINNED_NOW;
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-000c smoke story',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
}

function emptyChecklist(): ChecklistData {
  return { items: [] };
}

function run(): void {
  const savedEnv = { ...process.env };
  const tmpRoots: string[] = [];
  try {
    // ─── PURE derivation: two findings same localSignature (1 fixed, 1 FP) ────
    check('pure: same-signature fixed+false_positive => signalScore 1/3, support 2', () => {
      const findings: SignalSourceFinding[] = [
        {
          storyId: 'B-aaa', id: 'B-aaa:F-001', category: 'security', signatureTag: 'XSS',
          status: 'resolved', resolutionType: 'fixed', files: ['src/app.ts'],
          lifecyclePhase: 'review', createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          storyId: 'B-bbb', id: 'B-bbb:F-009', category: 'security', signatureTag: 'XSS',
          status: 'dismissed', dismissReasonType: 'false_positive', files: ['src/other.ts'],
          lifecyclePhase: 'review', createdAt: '2026-02-02T00:00:00.000Z',
        },
      ];
      const cache = deriveFindingSignals(findings, { now: PINNED_NOW });
      assert.equal(cache.schemaVersion, FINDING_SIGNALS_SCHEMA_VERSION);
      assert.equal(cache.updatedAt, PINNED_NOW);
      assert.equal(cache.signals.length, 1, 'one merged signal');
      const s = cache.signals[0];
      assert.equal(s.localSignature, 'security|XSS|ts|review');
      assert.equal(s.support, 2, 'support = positive(1) + negative(1)');
      assert.ok(Math.abs(s.signalScore - 1 / 3) < 1e-9, `signalScore=${s.signalScore}`);
      assert.equal(s.counts.resolved, 1);
      assert.equal(s.counts.dismissed, 1);
      assert.equal(s.counts.falsePositive, 1);
      assert.deepEqual(s.fileKinds, ['ts']);
      assert.equal(s.lastSeen, '2026-02-02T00:00:00.000Z', 'lastSeen = max createdAt');
      assert.deepEqual(s.exampleStoryIds, ['B-aaa', 'B-bbb']);
    });

    // ─── PURE: partially_mitigated contributes 0.5 to positive ────────────────
    check('pure: partially_mitigated contributes 0.5 to positive', () => {
      const cache = deriveFindingSignals([
        { category: 'perf', signatureTag: 'N1', status: 'resolved', resolutionType: 'partially_mitigated', files: ['a.go'] },
      ], { now: PINNED_NOW });
      const s = cache.signals[0];
      // positive=0.5, negative=0 => score = 0.5/(0.5+0+1) = 1/3
      assert.ok(Math.abs(s.signalScore - 1 / 3) < 1e-9, `signalScore=${s.signalScore}`);
      assert.equal(s.support, 0.5);
      assert.equal(s.counts.partiallyMitigated, 1);
    });

    // ─── EDGE: zero-sample => empty signals, no NaN ───────────────────────────
    check('edge: zero findings => empty signals, no NaN', () => {
      const empty: SignalSourceFinding[] = [];
      const cache = deriveFindingSignals(empty, { now: PINNED_NOW });
      assert.equal(cache.signals.length, 0, 'no signals for zero samples');
      assert.equal(cache.updatedAt, PINNED_NOW);
      for (const s of cache.signals) assert.ok(!Number.isNaN(s.signalScore), 'never NaN');
    });

    // ─── EDGE: single-hit fixed => signalScore 0.5, support 1 ─────────────────
    check('edge: single fixed => signalScore 0.5, support 1', () => {
      const cache = deriveFindingSignals([
        { category: 'edge', status: 'resolved', resolutionType: 'fixed', files: ['x.ts'] },
      ], { now: PINNED_NOW });
      const s = cache.signals[0];
      assert.equal(s.signalScore, 0.5, 'one fixed => 1/(1+0+1)=0.5');
      assert.equal(s.support, 1);
      assert.ok(!Number.isNaN(s.signalScore));
    });

    // ─── EDGE: signatureTag absent => coarse category+fileKind grouping ───────
    check('edge: signatureTag absent => coarse grouping (empty tag segment)', () => {
      const cache = deriveFindingSignals([
        { category: 'happy', status: 'resolved', resolutionType: 'fixed', files: ['m.ts'] },
        { category: 'happy', status: 'open', files: ['n.ts'] },
      ], { now: PINNED_NOW });
      assert.equal(cache.signals.length, 1, 'both coarse-grouped into happy||ts|review');
      assert.equal(cache.signals[0].localSignature, 'happy||ts|review');
      assert.equal(cache.signals[0].signatureTag, undefined);
    });

    // ─── EDGE/ADVERSARIAL: malformed / missing fields tolerated ───────────────
    check('adversarial: malformed/missing-field findings do not throw, no NaN', () => {
      const dirty = [
        {} as SignalSourceFinding,
        { files: [] } as SignalSourceFinding,
        { category: 'x' } as SignalSourceFinding,
        null as unknown as SignalSourceFinding,
        undefined as unknown as SignalSourceFinding,
        { category: 'x', files: ['noext'] } as SignalSourceFinding,
      ];
      const cache = deriveFindingSignals(dirty, { now: PINNED_NOW });
      for (const s of cache.signals) {
        assert.ok(!Number.isNaN(s.signalScore), 'no NaN score');
        assert.ok(!Number.isNaN(s.support), 'no NaN support');
      }
      // unknown/category fallbacks must surface, no throw reaching here.
      assert.ok(cache.signals.length >= 1);
    });

    // ─── fileKind derivation: extension vs dir fallback ───────────────────────
    check('pure: fileKind = extension; dir fallback when no extension; unknown when empty', () => {
      const c1 = deriveFindingSignals([{ category: 'c', files: ['pkg/main/Foo.TS'] }], { now: PINNED_NOW });
      assert.equal(c1.signals[0].localSignature, 'c||ts|review');
      const c2 = deriveFindingSignals([{ category: 'c', files: ['Makefile'] }], { now: PINNED_NOW });
      // no extension on a top-level file => dir-segment fallback = the file itself segment 'makefile'
      assert.equal(c2.signals[0].fileKinds[0], 'makefile');
      const c3 = deriveFindingSignals([{ category: 'c' }], { now: PINNED_NOW });
      assert.equal(c3.signals[0].fileKinds[0], 'unknown');
    });

    // ─── learning-store: ensureLearningDir on fresh temp ──────────────────────
    check('learning-store: ensureLearningDir creates .lattice/learning/', () => {
      const root = mkTempRoot(); tmpRoots.push(root);
      const dir = ensureLearningDir(root);
      assert.ok(existsSync(dir), 'directory created');
      // idempotent second call
      assert.doesNotThrow(() => ensureLearningDir(root));
    });

    // ─── learning-store: round-trip write -> read identical ───────────────────
    check('learning-store: write then read returns identical cache (round-trip)', () => {
      const root = mkTempRoot(); tmpRoots.push(root);
      const cache = deriveFindingSignals([
        { category: 'security', signatureTag: 'XSS', status: 'resolved', resolutionType: 'fixed', files: ['a.ts'] },
      ], { now: PINNED_NOW });
      const written = writeFindingSignals(root, cache);
      assert.ok(existsSync(written), 'cache file exists (auto-created dir hierarchy)');
      const readBack = readFindingSignals(root);
      assert.deepEqual(readBack, cache, 'round-trip deepEqual');
    });

    // ─── learning-store: identical data re-write is byte-identical ────────────
    check('learning-store: re-writing identical data is byte-identical', () => {
      const root = mkTempRoot(); tmpRoots.push(root);
      const cache = deriveFindingSignals([
        { category: 'b', signatureTag: 't', status: 'resolved', resolutionType: 'fixed', files: ['z.ts'] },
      ], { now: PINNED_NOW });
      const p = writeFindingSignals(root, cache);
      const first = readFileSync(p, 'utf-8');
      writeFindingSignals(root, cache);
      const second = readFileSync(p, 'utf-8');
      assert.equal(first, second, 'byte-identical re-write');
    });

    // ─── learning-store: missing file => null ─────────────────────────────────
    check('learning-store: readFindingSignals on missing file => null', () => {
      const root = mkTempRoot(); tmpRoots.push(root);
      assert.equal(readFindingSignals(root), null);
    });

    // ─── learning-store: malformed JSON => null (never throws) ─────────────────
    check('learning-store: readFindingSignals on malformed JSON => null (no throw)', () => {
      const root = mkTempRoot(); tmpRoots.push(root);
      const p = resolveFindingSignalsPath(root);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '{ this is : not json', 'utf-8');
      assert.equal(readFindingSignals(root), null);
    });

    // ─── ADAPTER: derive via store.readFindings port ──────────────────────────
    check('adapter: deriveFindingSignalsFromStore reads via store port + persists matching cache', () => {
      const { root } = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      const storyId = 'B-port';
      store.writeStory(storyId, newStory(storyId));
      store.writeChecklist(storyId, emptyChecklist());
      store.writeFindings(storyId, {
        findings: [
          {
            id: `${storyId}:F-001`, desc: 'xss', severity: 'high', category: 'adversarial',
            status: 'resolved', files: ['src/app.ts'], createdAt: PINNED_NOW,
            // Phase-1b forward-compat enums on the stored finding:
            ...( { signatureTag: 'XSS', resolutionType: 'fixed' } as Record<string, unknown> ),
          },
          {
            id: `${storyId}:F-002`, desc: 'maybe', severity: 'medium', category: 'adversarial',
            status: 'dismissed', files: ['src/app.ts'], createdAt: PINNED_NOW,
            ...( { signatureTag: 'XSS', dismissReasonType: 'false_positive' } as Record<string, unknown> ),
          },
        ],
      } as unknown as Parameters<StoryStore['writeFindings']>[1]);

      // listStoryIds must enumerate the seeded story (index.json present).
      assert.ok(store.listStoryIds().includes(storyId), 'store enumerates the seeded story');

      const cache = deriveFindingSignalsFromStore(store, { now: PINNED_NOW, projectRoot: root });
      assert.equal(cache.signals.length, 1, 'aggregated into one signal');
      const s = cache.signals[0];
      assert.equal(s.localSignature, 'adversarial|XSS|ts|review');
      assert.equal(s.support, 2);
      assert.ok(Math.abs(s.signalScore - 1 / 3) < 1e-9);

      // The persisted cache (written through the learning-store) matches.
      const onDisk = readFindingSignals(root);
      assert.deepEqual(onDisk, cache, 'persisted cache matches derived');
    });

    // ─── ADAPTER: empty store (no findings) => empty cache, no throw ───────────
    check('adapter: store with no findings => empty cache, no throw', () => {
      const { root } = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      const cache = deriveFindingSignalsFromStore(store, { now: PINNED_NOW, projectRoot: root });
      assert.equal(cache.signals.length, 0, 'empty store => empty signals');
    });

    // ─── GATE-SAFETY: writeFindingSignals leaves currentMaterialHash unchanged ─
    check('gate-safety: currentMaterialHash identical before/after cache write (create)', () => {
      const { root } = mkGitProject(); tmpRoots.push(root);
      const before = currentMaterialHash(root);
      assert.ok(before, 'baseline material hash available');
      const cache = deriveFindingSignals([
        { category: 'security', signatureTag: 'XSS', status: 'resolved', resolutionType: 'fixed', files: ['a.ts'] },
      ], { now: PINNED_NOW });
      writeFindingSignals(root, cache);
      const afterCreate = currentMaterialHash(root);
      assert.equal(afterCreate, before, 'create does not change material hash');
    });

    check('gate-safety: overwrite with different content + create-then-delete keep hash unchanged', () => {
      const { root } = mkGitProject(); tmpRoots.push(root);
      const before = currentMaterialHash(root);
      const c1 = deriveFindingSignals([{ category: 'a', files: ['a.ts'], status: 'resolved', resolutionType: 'fixed' }], { now: PINNED_NOW });
      const path = writeFindingSignals(root, c1);
      const c2 = deriveFindingSignals([{ category: 'b', files: ['b.go'], status: 'dismissed', dismissReasonType: 'false_positive' }], { now: PINNED_NOW });
      writeFindingSignals(root, c2);
      assert.equal(currentMaterialHash(root), before, 'repeated overwrite excluded');
      rmSync(path, { force: true });
      assert.equal(currentMaterialHash(root), before, 'create-then-delete leaves no ghost');
    });

    check('gate-safety: learning-log append leaves currentMaterialHash unchanged', () => {
      const { root } = mkGitProject(); tmpRoots.push(root);
      const before = currentMaterialHash(root);
      const logPath = resolveLearningLogPath(root);
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({ at: PINNED_NOW, kind: 'derive' })}\n`, 'utf-8');
      assert.equal(currentMaterialHash(root), before, 'learning-log append excluded');
    });

    // ─── REGISTRY: both entries present with correct properties ────────────────
    check('registry: finding-signals.json + learning-log.jsonl are exclude/volatile/repairable', () => {
      for (const rel of ['.lattice/learning/finding-signals.json', '.lattice/learning/learning-log.jsonl']) {
        const entry = findRuntimeArtifactEntry(rel);
        assert.ok(entry, `registry entry exists for ${rel}`);
        assert.equal(entry?.materialHash, 'exclude', `${rel} materialHash=exclude`);
        assert.equal(entry?.volatile, true, `${rel} volatile=true`);
        assert.ok(isMaterialExcludedRuntimeArtifactPath(rel), `${rel} material-excluded`);
        assert.ok(isVolatileRuntimeArtifactPath(rel), `${rel} volatile`);
        assert.ok(isRepairableTrackedRuntimeArtifactPath(rel), `${rel} repairable`);
      }
    });

    // ─── STATIC: isolation-bar import scan over the three modules ──────────────
    // The three modules live flat in core/. Any `../` import would leave core/.
    // The leaf (types) and the learning-store must have ZERO non-leaf imports:
    // their only relative dependency is the leaf sibling ./experience-layer-types.js.
    // finding-signals.ts is allowed exactly ONE non-leaf sibling: ./store.js (the
    // read-only store port). None may contain `../` (out of core/) or `../../`.
    check('static: types + learning-store import only the leaf; finding-signals adds only ./store.js; no ../ anywhere', () => {
      const types = readFileSync(join(REPO_CORE, 'experience-layer-types.ts'), 'utf-8');
      const ls = readFileSync(join(REPO_CORE, 'learning-store.ts'), 'utf-8');
      const fs = readFileSync(join(REPO_CORE, 'finding-signals.ts'), 'utf-8');

      // (1) No `../` import in any of the three (would leave core/).
      for (const [name, src] of [['types', types], ['learning-store', ls], ['finding-signals', fs]] as const) {
        assert.equal(parentImports(src).length, 0, `${name} must contain no ../ import, got: ${parentImports(src).join(', ')}`);
        assert.equal(deepParentImports(src).length, 0, `${name} must contain no ../../ import`);
      }

      // (2) The leaf and the learning-store import only ./experience-layer-types.js.
      const allowedLeaf = ['./experience-layer-types.js'];
      assert.deepEqual(relativeImports(types), [], `types.ts must have no relative imports, got: ${relativeImports(types).join(', ')}`);
      assert.deepEqual(relativeImports(ls), allowedLeaf, `learning-store.ts must import only the leaf, got: ${relativeImports(ls).join(', ')}`);

      // (3) finding-signals.ts: only siblings ./experience-layer-types.js,
      //     ./learning-store.js, and the store port ./store.js.
      const fsRel = relativeImports(fs);
      const fsAllowed = new Set(['./experience-layer-types.js', './learning-store.js', './store.js']);
      for (const spec of fsRel) {
        assert.ok(fsAllowed.has(spec), `finding-signals.ts has unexpected import ${spec}`);
      }
      assert.ok(fsRel.includes('./store.js'), 'finding-signals.ts must import the store port ./store.js');
    });

    // ─── ADVERSARIAL: prove the static scan is not vacuously true ──────────────
    check('adversarial: fake ../../ and ../ imports are caught by the scan (non-vacuous)', () => {
      const clean = readFileSync(join(REPO_CORE, 'learning-store.ts'), 'utf-8');
      assert.equal(deepParentImports(clean).length, 0, 'clean baseline: no ../../');
      assert.equal(parentImports(clean).length, 0, 'clean baseline: no ../');

      const tamperedDeep = `${clean}\nimport { evil } from '../../foo.js';\n`;
      assert.equal(deepParentImports(tamperedDeep).length, 1, 'tampered ../../ import detected');
      assert.ok(parentImports(tamperedDeep).includes('../../foo.js'), 'parent scan also flags ../../');

      const tamperedParent = `${clean}\nimport { handler } from '../handlers/x.js';\n`;
      assert.equal(parentImports(tamperedParent).length, 1, 'tampered ../ import detected');
      assert.ok(parentImports(tamperedParent).includes('../handlers/x.js'), 'parent scan flags ../');
    });

    console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
    if (passed !== total) {
      process.exitCode = 1;
      return;
    }
    console.log('smoke passed');
  } finally {
    for (const root of tmpRoots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    // Restore env exactly (delete keys added during the run).
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
}

/** All relative (`./` or `../`) `from '...'` import specifiers in a module. */
function relativeImports(src: string): string[] {
  const out: string[] = [];
  const rx = /from\s+'(\.\.?\/[^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** `../...` import specifiers (any import that leaves the current directory). */
function parentImports(src: string): string[] {
  return relativeImports(src).filter((spec) => spec.startsWith('../'));
}

/** Only `../../`-rooted (cross-package) import specifiers. */
function deepParentImports(src: string): string[] {
  return relativeImports(src).filter((spec) => spec.startsWith('../../'));
}

run();
