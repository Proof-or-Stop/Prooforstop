#!/usr/bin/env node
/**
 * B-7561 CHK-004: smoke suite for Experience Layer Phase 3 (FINAL slice) — Story
 * Recall, structured-field similarity over the existing `story_list` scan.
 *
 * Coverage (named `check:` lines; sets exitCode=1 on any failure; prints
 * `smoke passed` + `TOTAL N | PASS N | FAIL N` at the very end):
 *
 *   SCORING (pure core/story-recall.ts):
 *     • buildStoryProfile populates every StoryProfile field from story metadata.
 *     • buildStoryProfile on empty/minimal metadata => valid profile, empty
 *       arrays, no crash (graceful degradation) + tolerates unexpected fields.
 *     • scoreSimilarity: an overlapping profile scores ABOVE a disjoint one.
 *     • symmetric: score(a,b) === score(b,a).
 *     • deterministic: identical inputs => identical score.
 *     • MULTI-FIELD: one shared keyword alone does NOT outrank a profile sharing
 *       keywords + fileKinds + touchpoints (no single-field domination).
 *     • Jaccard(∅, ∅) => 0 (no NaN) for two empty profiles.
 *     • duplicate keywords do not inflate similarity (set semantics).
 *
 *   RANKING (recallSimilarStories):
 *     • most-similar candidate ranked first; reasons present per result.
 *     • top-N respected (topN=1 truncates); zero-score dropped.
 *     • self-exclusion: the target's own storyId is excluded from its matches.
 *     • empty candidate set => [] (no crash); topN=0 => [].
 *
 *   READ-ONLY HANDLER (over a seeded temp project's story_list scan):
 *     • recall --story <id> returns ranked results AND writes NOTHING: snapshot
 *       the entire .lattice tree before/after — byte-identical, no new file, no
 *       derived-index/cache file anywhere.
 *     • recall --query returns keyword-matched stories.
 *     • recall with neither arg prints usage; unknown story id => informative,
 *       no crash; --top 0 => no results; injection-y query => no crash.
 *
 *   IMPORT FENCE (non-vacuous):
 *     • core/story-recall.ts imports ONLY ./experience-layer-types.js + node:
 *       (static scan + a planted-foreign-import mutation check).
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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { StoryStore } from '../core/store.js';
import { resetConfigCache, loadConfig } from '../core/config.js';
import { createRecallHandlers } from '../handlers/recall.js';
import {
  buildStoryProfile,
  buildQueryProfile,
  recallSimilarStories,
  scoreSimilarity,
  type StoryProfileInput,
} from '../core/story-recall.js';
import type { HandlerContext } from '../handlers/context.js';
import type { StoryProfile } from '../core/experience-layer-types.js';
import type { Finding, StoryInfo, UnderstandingData, DecisionData } from '../core/types.js';

const PINNED_NOW = '2026-06-17T00:00:00.000Z';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}
const REPO_ROOT = repoRoot();
const MAIN_DIR = join(REPO_ROOT, 'packages', 'main');

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
  const root = mkdtempSync(join(tmpdir(), 'b7561-recall-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return root;
}

function newStory(storyId: string, over: Partial<StoryInfo> = {}): StoryInfo {
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-7561 recall smoke story',
    type: 'feature',
    phase: 'DONE',
    priority: 'medium',
    createdAt: PINNED_NOW,
    startedAt: PINNED_NOW,
    endedAt: null,
    events: [{ phase: 'DONE', action: 'advance', timestamp: PINNED_NOW }],
    ...over,
  };
}

/** Build a HandlerContext bound to a hermetic temp project root. */
function mkCtx(root: string): { ctx: HandlerContext; store: StoryStore } {
  resetConfigCache();
  const store = new StoryStore(root);
  const config = loadConfig(root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, config.scanRoot), log: () => {} };
  return { ctx, store };
}

interface SeedSpec {
  story: StoryInfo;
  understanding?: UnderstandingData;
  decision?: DecisionData;
  findings?: Finding[];
}

function seed(store: StoryStore, spec: SeedSpec): void {
  store.writeStory(spec.story.storyId, spec.story);
  store.writeChecklist(spec.story.storyId, { items: [] });
  if (spec.understanding) store.writeUnderstanding(spec.story.storyId, spec.understanding);
  if (spec.decision) store.writeDecision(spec.story.storyId, spec.decision);
  if (spec.findings) store.writeFindings(spec.story.storyId, { findings: spec.findings });
}

function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  const bare = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** Recursive byte-snapshot of a directory tree: sorted `relpath::content`. */
function treeSnapshot(dir: string): string {
  if (!existsSync(dir)) return '<no-dir>';
  const entries: string[] = [];
  const walk = (cur: string): void => {
    for (const d of readdirSync(cur, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(cur, d.name);
      if (d.isDirectory()) walk(full);
      else entries.push(`${relative(dir, full)}::${readFileSync(full, 'utf-8')}`);
    }
  };
  walk(dir);
  return entries.sort().join('\n');
}

/** All file paths (recursive) under a directory, relative to it. */
function treeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const d of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, d.name);
      if (d.isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/** A profile sharing keywords + fileKinds + touchpoints with `auth`. */
function profileShared(storyId: string): StoryProfile {
  return buildStoryProfile({
    storyId,
    title: 'auth token timing comparison hardening',
    type: 'fix',
    phase: 'DONE',
    priority: 'high',
    understanding: { task: 'harden auth token compare', outcome: 'constant-time compare', touchpoints: ['src/handlers/auth.ts', 'src/core/token.ts'] },
    findings: [{ desc: 'auth token compare timing side channel', signatureTag: 'auth-bypass', files: ['src/handlers/auth.ts'] }],
  });
}

function run(): void {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const tmpRoots: string[] = [];
  delete process.env.LATTICE_AGENT;

  try {
    // ─── buildStoryProfile populates every field ─────────────────────────────
    check('buildStoryProfile: populates every StoryProfile field from metadata', () => {
      const input: StoryProfileInput = {
        storyId: 'B-prof', title: 'worker schedule rotation engine',
        type: 'feature', phase: 'DONE', priority: 'high',
        keywords: ['scheduling'],
        riskSignals: [{ category: 'concurrency', matched: 'race' }],
        understanding: { task: 'rotate worker schedules fairly', outcome: 'fair rotation shipped', touchpoints: ['src/core/schedule.ts', 'src/handlers/worker.ts'] },
        decision: { chosen: 'round-robin', rationale: 'simplest fair policy', principles: ['fairness'] },
        findings: [{ desc: 'rotation skipped a worker on wrap', signatureTag: 'off-by-one', files: ['src/core/schedule.ts'], category: 'edge' }],
      };
      const p = buildStoryProfile(input);
      assert.equal(p.storyId, 'B-prof');
      assert.equal(p.title, 'worker schedule rotation engine');
      assert.equal(p.type, 'feature');
      assert.equal(p.phase, 'DONE');
      assert.equal(p.priority, 'high');
      assert.ok(p.keywords.length > 0, 'keywords populated');
      assert.ok(p.keywords.includes('worker') && p.keywords.includes('schedule'), 'title keywords present');
      assert.ok(p.fileKinds.some((k) => k.startsWith('ext:')), 'fileKinds populated (ext)');
      assert.ok(p.fileKinds.some((k) => k.startsWith('dir:')), 'fileKinds populated (dir)');
      assert.ok(p.touchpoints.includes('src/core/schedule.ts'), 'touchpoints populated');
      assert.deepEqual(p.riskSignals, ['concurrency'], 'riskSignals projected to category');
      assert.ok(p.notableFindings.length > 0, 'notableFindings populated');
      assert.ok(p.notableDecisions.length > 0, 'notableDecisions populated');
      assert.equal(p.outcome, 'fair rotation shipped', 'outcome populated');
    });

    check('buildStoryProfile: empty/minimal metadata => valid profile, empty arrays, no crash', () => {
      const p = buildStoryProfile({});
      assert.equal(p.storyId, '');
      assert.deepEqual(p.keywords, []);
      assert.deepEqual(p.fileKinds, []);
      assert.deepEqual(p.touchpoints, []);
      assert.deepEqual(p.riskSignals, []);
      assert.deepEqual(p.notableFindings, []);
      assert.deepEqual(p.notableDecisions, []);
      assert.equal(p.outcome, undefined, 'no outcome when none recorded');
    });

    check('buildStoryProfile: tolerates unexpected/extra fields (forward-compat)', () => {
      const weird = { storyId: 'B-x', title: 'a', futureField: { deep: [1, 2] }, keywords: 'not-an-array', findings: 'nope' } as unknown as StoryProfileInput;
      const p = buildStoryProfile(weird);
      assert.equal(p.storyId, 'B-x');
      assert.deepEqual(p.keywords, [], 'non-array keywords ignored, no crash');
      assert.deepEqual(p.notableFindings, [], 'non-array findings ignored, no crash');
    });

    check('buildStoryProfile: deduped + sorted arrays (deterministic)', () => {
      const a = buildStoryProfile({ storyId: 'B-d', title: 'auth auth token token', keywords: ['auth', 'auth'] });
      const b = buildStoryProfile({ storyId: 'B-d', title: 'token token auth auth', keywords: ['auth'] });
      assert.deepEqual(a.keywords, b.keywords, 'duplicate keyword sources collapse to the same deduped+sorted set');
      assert.deepEqual([...a.keywords].sort(), a.keywords, 'keywords are sorted');
    });

    // ─── scoreSimilarity invariants ──────────────────────────────────────────
    check('scoreSimilarity: overlapping > disjoint (core ranking invariant)', () => {
      const target = profileShared('B-target');
      const overlapping = profileShared('B-over');
      const disjoint = buildStoryProfile({
        storyId: 'B-dis', title: 'css layout grid spacing tokens', type: 'chore', phase: 'DEV',
        understanding: { task: 'tweak grid spacing', outcome: 'nicer layout', touchpoints: ['web/styles/grid.css'] },
      });
      const sOver = scoreSimilarity(target, overlapping).score;
      const sDis = scoreSimilarity(target, disjoint).score;
      assert.ok(sOver > sDis, `overlapping (${sOver}) must outrank disjoint (${sDis})`);
      assert.ok(sOver > 0, 'overlapping profile scores positive');
    });

    check('scoreSimilarity: symmetric (score(a,b) === score(b,a))', () => {
      const a = profileShared('B-a');
      const b = buildStoryProfile({ storyId: 'B-b', title: 'auth session token rotation', type: 'fix', phase: 'DONE', understanding: { task: 'rotate auth token', outcome: '', touchpoints: ['src/core/token.ts'] } });
      assert.equal(scoreSimilarity(a, b).score, scoreSimilarity(b, a).score, 'similarity must be symmetric');
    });

    check('scoreSimilarity: deterministic (identical inputs => identical score)', () => {
      const a = profileShared('B-a');
      const b = profileShared('B-b');
      const s1 = scoreSimilarity(a, b).score;
      const s2 = scoreSimilarity(a, b).score;
      assert.equal(s1, s2, 'identical inputs produce identical score');
    });

    check('scoreSimilarity: MULTI-FIELD — one shared keyword does NOT outrank multi-field overlap', () => {
      const target = profileShared('B-target');
      // shares MANY dimensions (keywords + fileKinds + touchpoints + type + phase)
      const multi = profileShared('B-multi');
      // shares ONLY a single keyword (no fileKinds, no touchpoints, no type/phase match)
      const singleKw = buildStoryProfile({
        storyId: 'B-single', title: 'auth', type: 'chore', phase: 'DEV',
      });
      assert.ok(scoreSimilarity(target, singleKw).score > 0, 'single shared keyword is non-zero');
      assert.ok(
        scoreSimilarity(target, multi).score > scoreSimilarity(target, singleKw).score,
        'multi-field overlap must beat a single shared keyword (no single-field domination)',
      );
    });

    check('scoreSimilarity: single shared field-dimension => low but non-zero', () => {
      // same type only, zero keyword/fileKind/touchpoint overlap.
      const a = buildStoryProfile({ storyId: 'B-t1', title: 'alpha bravo charlie', type: 'feature', phase: 'DEV' });
      const b = buildStoryProfile({ storyId: 'B-t2', title: 'delta echo foxtrot', type: 'feature', phase: 'DONE' });
      const { score } = scoreSimilarity(a, b);
      assert.ok(score > 0, 'same-type boost yields non-zero');
      assert.ok(score < 0.2, `single-dimension score stays low (got ${score})`);
    });

    check('scoreSimilarity: Jaccard(∅,∅) => 0 (no NaN) for two empty profiles', () => {
      const empty = buildStoryProfile({ storyId: 'B-e1' });
      const empty2 = buildStoryProfile({ storyId: 'B-e2' });
      const { score } = scoreSimilarity(empty, empty2);
      assert.ok(!Number.isNaN(score), 'score is not NaN');
      assert.equal(score, 0, 'two empty profiles score exactly 0');
    });

    check('scoreSimilarity: duplicate keywords do not inflate similarity (set semantics)', () => {
      const dup = buildStoryProfile({ storyId: 'B-dup', title: 'auth', keywords: ['auth', 'auth', 'auth'] });
      const single = buildStoryProfile({ storyId: 'B-sgl', title: 'auth', keywords: ['auth'] });
      const other = profileShared('B-o');
      assert.equal(
        scoreSimilarity(dup, other).score,
        scoreSimilarity(single, other).score,
        'duplicate keyword injection must not change the score (deduped)',
      );
    });

    // ─── recallSimilarStories ────────────────────────────────────────────────
    check('recallSimilarStories: most-similar first; reasons present', () => {
      const target = profileShared('B-target');
      const similar = profileShared('B-similar');
      const disjoint = buildStoryProfile({ storyId: 'B-disjoint', title: 'css grid spacing', type: 'chore', phase: 'DEV', understanding: { task: 'css', outcome: '', touchpoints: ['web/x.css'] } });
      const matches = recallSimilarStories(target, [disjoint, similar], 5);
      assert.ok(matches.length >= 1, 'at least one match');
      assert.equal(matches[0].storyId, 'B-similar', 'most-similar ranked first');
      assert.ok(matches[0].reasons.length > 0, 'reasons present for the top match');
    });

    check('recallSimilarStories: top-N respected (topN=1 truncates); zero-score dropped', () => {
      const target = profileShared('B-target');
      const a = profileShared('B-a');
      const b = profileShared('B-b');
      const zero = buildStoryProfile({ storyId: 'B-zero', title: 'qqqq wwww eeee', type: 'chore', phase: 'DEV' });
      const matches = recallSimilarStories(target, [a, b, zero], 1);
      assert.equal(matches.length, 1, 'topN=1 returns exactly one result');
      assert.ok(!matches.some((m) => m.storyId === 'B-zero'), 'zero-score candidate dropped');
    });

    check('recallSimilarStories: self-exclusion (target storyId excluded)', () => {
      const target = profileShared('B-self');
      const selfCopy = profileShared('B-self'); // same storyId
      const other = profileShared('B-other');
      const matches = recallSimilarStories(target, [selfCopy, other], 5);
      assert.ok(!matches.some((m) => m.storyId === 'B-self'), 'a story never recalls itself');
      assert.ok(matches.some((m) => m.storyId === 'B-other'), 'other candidate still ranked');
    });

    check('recallSimilarStories: empty candidates => []; topN=0 => []', () => {
      const target = profileShared('B-t');
      assert.deepEqual(recallSimilarStories(target, [], 5), [], 'empty candidates => []');
      assert.deepEqual(recallSimilarStories(target, [profileShared('B-c')], 0), [], 'topN=0 => []');
      assert.deepEqual(recallSimilarStories(target, [profileShared('B-c')], -3), [], 'negative topN => []');
    });

    // ─── F-002: large candidate set ranking (deterministic correctness at scale) ─
    check('CHK-002:adversarial:0 large candidate set ranking', () => {
      // Target shares keywords + fileKinds + touchpoints with exactly ONE planted
      // candidate; the other 120 are varied/disjoint. The known-best must rank #1.
      const target = profileShared('B-target');

      const candidates: StoryProfile[] = [];
      // The single clearly-most-similar candidate (shares every structural field).
      const best = profileShared('B-best-match');
      candidates.push(best);

      // 120 varied/disjoint candidates: distinct titles, distinct file areas,
      // distinct types/phases — none should share the target's structure.
      const areas = ['web/styles', 'docs/guides', 'scripts/build', 'config/env', 'assets/img'];
      const exts = ['css', 'md', 'sh', 'yaml', 'png'];
      const types = ['chore', 'docs', 'refactor', 'test', 'perf'];
      const phases = ['DEV', 'PLAN', 'REVIEW', 'TEST', 'INIT'];
      for (let i = 0; i < 120; i += 1) {
        const a = areas[i % areas.length];
        const ext = exts[i % exts.length];
        candidates.push(buildStoryProfile({
          storyId: `B-noise-${String(i).padStart(3, '0')}`,
          title: `widget palette gradient spacing variant ${i} layout column`,
          type: types[i % types.length],
          phase: phases[i % phases.length],
          understanding: {
            task: `adjust ${a} variant ${i}`,
            outcome: '',
            touchpoints: [`${a}/file-${i}.${ext}`],
          },
        }));
      }
      assert.ok(candidates.length >= 100, `>=100 candidates built (got ${candidates.length})`);

      const matches = recallSimilarStories(target, candidates, 5);
      assert.ok(matches.length >= 1, 'large set yields at least one ranked match');
      assert.equal(matches[0].storyId, 'B-best-match', 'the known most-similar story ranks #1 at scale');
      assert.ok(matches[0].score > 0, 'top match has a positive score');
      // The call completed and produced a coherent, ordered result.
      for (let i = 1; i < matches.length; i += 1) {
        assert.ok(matches[i - 1].score >= matches[i].score, 'matches are sorted by score desc');
      }
    });

    // ─── F-003: malformed / partial profiles must not crash ──────────────────
    check('CHK-002:adversarial:2 malformed/partial profiles no crash', () => {
      // buildStoryProfile on partial / malformed metadata must NOT throw and must
      // return a well-formed StoryProfile (all array fields present, never null).
      const malformedInputs: unknown[] = [
        {},                                                       // empty
        { storyId: 'B-no-kw', title: '' },                        // empty title => no keywords
        { storyId: 'B-bad-kw', keywords: 'auth,token' },          // keywords not an array
        { storyId: 'B-bad-find', findings: 'oops' },              // findings not an array
        { storyId: 'B-null-und', understanding: null, decision: null }, // explicit nulls
        { storyId: 'B-no-tp', understanding: { task: 'x' } },     // missing touchpoints
        { storyId: 'B-bad-tp', understanding: { touchpoints: [1, 2, null, ''] } }, // non-string touchpoints
        { storyId: 'B-bad-find2', findings: [null, 42, { desc: 7, files: 'nope' }] }, // malformed finding members
        { storyId: 'B-bad-risk', riskSignals: [1, null, { nope: true }] }, // malformed riskSignals
        { storyId: 'B-deep', futureField: { a: [1] }, title: 'auth token compare hardening' }, // extra fields
      ];

      const builtProfiles: StoryProfile[] = [];
      for (const raw of malformedInputs) {
        const p = buildStoryProfile(raw as StoryProfileInput); // must not throw
        // Well-formed: every array field is an actual array; no undefined/null leaks.
        assert.ok(Array.isArray(p.keywords), 'keywords is an array');
        assert.ok(Array.isArray(p.fileKinds), 'fileKinds is an array');
        assert.ok(Array.isArray(p.touchpoints), 'touchpoints is an array');
        assert.ok(Array.isArray(p.riskSignals), 'riskSignals is an array');
        assert.ok(Array.isArray(p.notableFindings), 'notableFindings is an array');
        assert.ok(Array.isArray(p.notableDecisions), 'notableDecisions is an array');
        assert.equal(typeof p.storyId, 'string', 'storyId is a string');
        builtProfiles.push(p);
      }

      // recallSimilarStories over the malformed set + the real target must not
      // throw and must return a well-formed result. Malformed/empty profiles
      // (no overlap) score zero and are dropped; the one structural keyword-sharer
      // ("B-deep") may rank but nothing crashes.
      const target = profileShared('B-target');
      const matches = recallSimilarStories(target, builtProfiles, 5);
      assert.ok(Array.isArray(matches), 'recall returns an array on malformed candidates');
      for (const m of matches) {
        assert.equal(typeof m.storyId, 'string', 'each match has a string storyId');
        assert.equal(typeof m.score, 'number', 'each match has a numeric score');
        assert.ok(!Number.isNaN(m.score), 'no NaN score from a malformed profile');
        assert.ok(m.score > 0, 'only positive-score matches survive (malformed/empty dropped)');
        assert.ok(Array.isArray(m.reasons), 'each match has reasons[]');
      }
      // The fully-empty / disjoint malformed profiles must not appear (zero score).
      assert.ok(!matches.some((m) => m.storyId === 'B-no-kw'), 'keyword-less malformed profile dropped');
      assert.ok(!matches.some((m) => m.storyId === 'B-bad-find'), 'non-array-findings malformed profile dropped');

      // scoreSimilarity directly against a malformed-derived empty profile is 0, not NaN.
      const emptyish = buildStoryProfile({ storyId: 'B-empty' } as StoryProfileInput);
      const { score } = scoreSimilarity(target, emptyish);
      assert.ok(!Number.isNaN(score), 'malformed-derived empty profile scores a number, not NaN');
      assert.equal(score, 0, 'a disjoint malformed-derived profile scores 0');
    });

    // ─── READ-ONLY handler over the story_list scan ──────────────────────────
    check('handler: recall --story returns ranked results AND writes NOTHING (tree snapshot equal)', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createRecallHandlers(ctx);

      // Seed: a target + a clearly-similar story + a disjoint story.
      seed(store, {
        story: newStory('B-tgt', { title: 'auth token timing comparison', type: 'bug' }),
        understanding: { task: 'harden auth token compare', outcome: 'constant-time compare', facts: [], constraints: [], unknowns: [], touchpoints: ['src/handlers/auth.ts', 'src/core/token.ts'], timestamp: PINNED_NOW },
        findings: [{ id: 'B-tgt:F-001', desc: 'auth token compare timing side channel', severity: 'high', category: 'adversarial', status: 'resolved', signatureTag: 'auth-bypass', files: ['src/handlers/auth.ts'] }],
      });
      seed(store, {
        story: newStory('B-sim', { title: 'auth session token rotation', type: 'bug' }),
        understanding: { task: 'rotate auth token securely', outcome: 'rotation shipped', facts: [], constraints: [], unknowns: [], touchpoints: ['src/handlers/auth.ts', 'src/core/token.ts'], timestamp: PINNED_NOW },
      });
      seed(store, {
        story: newStory('B-dis', { title: 'css grid spacing tokens', type: 'chore' }),
        understanding: { task: 'tweak grid spacing', outcome: 'nicer layout', facts: [], constraints: [], unknowns: [], touchpoints: ['web/styles/grid.css'], timestamp: PINNED_NOW },
      });

      const latticeDir = join(root, '.lattice');
      const beforeTree = treeSnapshot(latticeDir);
      const beforeFiles = treeFiles(latticeDir);

      const out = h.recall({ storyId: 'B-tgt', top: 5 });

      const afterTree = treeSnapshot(latticeDir);
      const afterFiles = treeFiles(latticeDir);

      assert.match(out, /recall --story B-tgt/, 'header echoes the story');
      assert.match(out, /B-sim/, 'the similar story is ranked');
      // similar must outrank (appear before) the disjoint one — or disjoint scores 0 and is absent.
      const idxSim = out.indexOf('B-sim');
      const idxDis = out.indexOf('B-dis');
      assert.ok(idxSim >= 0, 'similar story present');
      assert.ok(idxDis === -1 || idxSim < idxDis, 'similar story outranks (precedes) the disjoint one');

      // READ-ONLY: the entire .lattice tree is byte-identical before/after.
      assert.equal(beforeTree, afterTree, 'recall wrote/modified NOTHING under .lattice');
      assert.deepEqual(beforeFiles, afterFiles, 'recall created no new file under .lattice');
    });

    check('handler: recall creates NO derived-index/cache file anywhere', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createRecallHandlers(ctx);
      seed(store, { story: newStory('B-a', { title: 'auth token compare' }), understanding: { task: 'auth', outcome: '', facts: [], constraints: [], unknowns: [], touchpoints: ['src/core/token.ts'], timestamp: PINNED_NOW } });
      seed(store, { story: newStory('B-b', { title: 'auth token rotation' }), understanding: { task: 'auth', outcome: '', facts: [], constraints: [], unknowns: [], touchpoints: ['src/core/token.ts'], timestamp: PINNED_NOW } });

      h.recall({ storyId: 'B-a', top: 5 });
      h.recall({ query: 'auth token', top: 5 });

      const all = treeFiles(root);
      const forbidden = all.filter((f) => /recall-index|recall-cache|story-recall-derived|recall.*\.cache/i.test(f));
      assert.deepEqual(forbidden, [], `recall must create no derived-index/cache file; found: ${forbidden.join(', ')}`);
    });

    check('handler: recall --query returns keyword-matched stories', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createRecallHandlers(ctx);
      seed(store, { story: newStory('B-ws', { title: 'worker schedule rotation' }), understanding: { task: 'rotate worker schedule', outcome: '', facts: [], constraints: [], unknowns: [], touchpoints: ['src/core/schedule.ts'], timestamp: PINNED_NOW } });
      seed(store, { story: newStory('B-css', { title: 'css grid spacing' }) });

      const out = h.recall({ query: 'worker schedule', top: 5 });
      assert.match(out, /recall --query "worker schedule"/, 'query header present');
      assert.match(out, /B-ws/, 'keyword-matched story returned');
      assert.ok(!/B-css/.test(out), 'non-matching story not returned (zero overlap dropped)');
    });

    check('handler: usage / unknown id / top 0 / injection query — no crash', () => {
      const root = mkProject(); tmpRoots.push(root); process.chdir(root);
      const { ctx, store } = mkCtx(root);
      const h = createRecallHandlers(ctx);
      seed(store, { story: newStory('B-only', { title: 'auth token' }) });

      assert.match(h.recall({}), /Usage:/, 'no args => usage');
      assert.match(h.recall({ storyId: 'B-nope' }), /story not found: B-nope/, 'unknown id => informative, no crash');
      assert.match(h.recall({ storyId: 'B-only', top: 0 }), /top 0/, 'top 0 => no results, no crash');
      // injection-y query: quotes / semicolons / newlines must not crash or execute anything.
      const inj = h.recall({ query: 'auth"; rm -rf /; echo $(whoami)\n--top 999', top: 3 });
      assert.ok(typeof inj === 'string', 'injection query returns a string (no crash/exec)');
      // A whitespace-only query trims to empty => treated as "no query" => usage (graceful, no crash).
      assert.match(h.recall({ query: '   ' }), /Usage:/, 'whitespace query => usage, no crash');
      // A non-empty query with NO usable keywords (all short/stop-words) => explicit no-results.
      assert.match(h.recall({ query: 'a an to' }), /no usable keywords/, 'keyword-less query => no results, no crash');
      // both --story and --query is a clear error (not a silent merge).
      assert.throws(() => h.recall({ storyId: 'B-only', query: 'x' }), /not both/, 'both args rejected');
    });

    check('buildQueryProfile: tokenizes a query into keywords; structural fields empty', () => {
      const p = buildQueryProfile('Worker Schedule Rotation Engine');
      assert.ok(p.keywords.includes('worker') && p.keywords.includes('schedule'), 'query keywords lower-cased');
      assert.deepEqual(p.fileKinds, [], 'query has no fileKinds');
      assert.deepEqual(p.touchpoints, [], 'query has no touchpoints');
      assert.equal(p.type, '', 'query has no type');
    });

    // ─── IMPORT FENCE (non-vacuous) ──────────────────────────────────────────
    check('import-fence: core/story-recall.ts imports ONLY ./experience-layer-types.js + node:', () => {
      const src = readFileSync(join(MAIN_DIR, 'src', 'core', 'story-recall.ts'), 'utf-8');
      const specs = importSpecifiers(src);
      assert.ok(specs.length > 0, 'story-recall.ts has imports (non-vacuous)');
      const allowed = new Set(['./experience-layer-types.js']);
      const foreign = specs.filter((s) => !s.startsWith('node:') && !allowed.has(s));
      assert.deepEqual(foreign, [], `story-recall.ts must import ONLY ./experience-layer-types.js + node:; found: ${foreign.join(', ')}`);
      assert.ok(specs.includes('./experience-layer-types.js'), 'story-recall.ts imports the leaf types');
      // load-bearing: it must NOT import the store, any handler, or any gate.
      assert.ok(!specs.some((s) => /store\.js$|handlers?\/|gate/i.test(s)), 'story-recall.ts imports no store / handler / gate');
    });

    check('import-fence: the static scan is non-vacuous (catches a planted foreign import)', () => {
      const real = readFileSync(join(MAIN_DIR, 'src', 'core', 'story-recall.ts'), 'utf-8');
      const planted = `import { StoryStore } from './store.js';\n${real}`;
      const specs = importSpecifiers(planted);
      const allowed = new Set(['./experience-layer-types.js']);
      const foreign = specs.filter((s) => !s.startsWith('node:') && !allowed.has(s));
      assert.deepEqual(foreign, ['./store.js'], 'the scanner must detect a planted foreign import');
    });
  } finally {
    process.chdir(savedCwd);
    process.env = savedEnv;
    for (const r of tmpRoots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }

  console.log(`\nTOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (process.exitCode === 1) {
    console.error('smoke FAILED');
    return;
  }
  console.log('smoke passed');
}

run();
