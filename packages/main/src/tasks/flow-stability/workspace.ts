import { strict as assert } from 'node:assert';

import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig, resetConfigCache } from '../../core/config.js';

import { classifyGitStatusRows, dirtyWorktreeClassifierOptionsFromConfig, parseGitPorcelainRow, DIRTY_WORKTREE_CATEGORIES, emptyDirtyWorktreeGroups } from '../../core/dirty-worktree.js';
import {
  DIRTY_GATE_POLICY,
  assertPolicyCovers,
  defaultAuditWriter,
  evaluateDirtyGate,
  AUDIT_PATH_SAMPLE_LIMIT,
  type AuditEvent,
  type AuditWriter,
} from '../../core/dirty-gate-policy.js';

import { ORIGINAL_TASKS_DIR } from './support.js';
import { write } from './support.js';

export function assertDirtyWorktreeClassifierGroupsOwnership(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-dirty-classifier-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const rename = parseGitPorcelainRow('R  packages/main/src/old.ts -> ./packages/main/src/new.ts');
    assert.equal(rename?.statusCode, 'R ');
    assert.equal(rename?.rawPath, './packages/main/src/new.ts');
    assert.equal(rename?.path, 'packages/main/src/new.ts');
    assert.equal(rename?.originalPath, 'packages/main/src/old.ts');

    const classification = classifyGitStatusRows([
      ' M .proof-or-stop/story/actives/B-smoke/checklist.json',
      ' M Docs/story/actives/B-smoke/test-evidence.json',
      '?? .proof-or-stop/activity.jsonl',
      ' M package.json',
      ' D proof-or-stop.config.json',
      'R  packages/main/src/old.ts -> ./packages/main/src/new.ts',
      '?? packages/main/tests/fixtures/dirty-owner.json',
      '?? packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json',
    ], dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)));

    assert.equal(classification.total, 8);
    assert.equal(classification.groups.proof_or_stop_metadata_changes.length, 2);
    assert.equal(classification.groups.runtime_artifact_changes.length, 1);
    assert.equal(classification.groups.declared_artifact_changes.length, 0, 'undeclared artifact extension point should stay empty by default');
    assert.equal(classification.groups.material_source_changes.length, 3);
    assert.equal(classification.groups.fixture_changes.length, 1);
    assert.equal(classification.groups.unexpected_dirty_files.length, 1);
    assert.equal(classification.groups.unexpected_dirty_files[0].path, 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json');
    assert.equal(classification.groups.runtime_artifact_changes[0].raw, '?? .proof-or-stop/activity.jsonl');
    assert.equal(classification.groups.runtime_artifact_changes[0].statusCode, '??');
    assert.equal(classification.groups.runtime_artifact_changes[0].rawPath, '.proof-or-stop/activity.jsonl');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDirtyGatePolicyAcrossGates(): void {
  const STORY = 'B-smoke-policy';
  const fixedNow = () => '2026-05-15T18:00:00.000Z';

  // Build a typed classification from a list of {category, path} pairs without
  // running classifyGitStatusRows (so the test is independent of the
  // classifier's heuristics). Status code "?? " keeps parseGitPorcelainRow
  // happy if anyone later swaps in a real row.
  function buildClassification(
    entries: Array<{ category: string; path: string }>,
  ): import('../../core/dirty-worktree.js').DirtyWorktreeClassification {
    const groups = emptyDirtyWorktreeGroups();
    for (const { category, path } of entries) {
      const cat = category as keyof typeof groups;
      groups[cat].push({
        raw: `?? ${path}`,
        statusCode: '??',
        rawPath: path,
        path,
        category: cat as any,
      });
    }
    return {
      total: entries.length,
      entries: DIRTY_WORKTREE_CATEGORIES.flatMap((c) => groups[c]),
      groups,
    };
  }

  // (1) registry-vs-policy invariant — preMortem #1 anchor.
  assert.equal(
    Object.keys(DIRTY_GATE_POLICY).length,
    DIRTY_WORKTREE_CATEGORIES.length,
    'DIRTY_GATE_POLICY entry count must equal DIRTY_WORKTREE_CATEGORIES.length (B-4b22 preMortem #1)',
  );
  assert.doesNotThrow(() => assertPolicyCovers(), 'assertPolicyCovers() must not throw against current registry');
  // Explicit blocking/passing partition is the safety contract.
  assert.equal(DIRTY_GATE_POLICY.material_source_changes.blocking, true);
  assert.equal(DIRTY_GATE_POLICY.fixture_changes.blocking, true);
  assert.equal(DIRTY_GATE_POLICY.unexpected_dirty_files.blocking, true);
  assert.equal(DIRTY_GATE_POLICY.proof_or_stop_metadata_changes.blocking, false);
  assert.equal(DIRTY_GATE_POLICY.runtime_artifact_changes.blocking, false);
  assert.equal(DIRTY_GATE_POLICY.declared_artifact_changes.blocking, false);

  // (2) blocking 3 categories coexist → allPass=false with names + counts.
  const blockingFixture = buildClassification([
    { category: 'material_source_changes', path: 'packages/main/src/foo.ts' },
    { category: 'fixture_changes', path: 'packages/main/tests/fixtures/x.json' },
    { category: 'unexpected_dirty_files', path: 'random.tmp' },
  ]);
  const blockingResult = evaluateDirtyGate(blockingFixture, {
    storyId: STORY,
    gate: 'test-pre-check',
    writer: null,
    now: fixedNow,
  });
  assert.equal(blockingResult.allPass, false, '3 blocking categories must yield allPass=false');
  assert.equal(blockingResult.blockingCounts.material_source_changes, 1);
  assert.equal(blockingResult.blockingCounts.fixture_changes, 1);
  assert.equal(blockingResult.blockingCounts.unexpected_dirty_files, 1);
  assert.match(blockingResult.summary, /material_source_changes=1/);
  assert.match(blockingResult.summary, /fixture_changes=1/);
  assert.match(blockingResult.summary, /unexpected_dirty_files=1/);
  assert.equal(blockingResult.auditEvents.length, 0, 'pure-blocking fixture must emit zero audit events');

  // (3) passing 3 categories coexist → allPass=true with 3 audit events.
  const passingFixture = buildClassification([
    { category: 'proof_or_stop_metadata_changes', path: '.proof-or-stop/story/actives/B-x/index.json' },
    { category: 'runtime_artifact_changes', path: '.proof-or-stop/activity.jsonl' },
    { category: 'declared_artifact_changes', path: 'packages/main/tests/output/declared.json' },
  ]);
  const passingCapture: AuditEvent[] = [];
  const passingResult = evaluateDirtyGate(passingFixture, {
    storyId: STORY,
    gate: 'done-gate',
    writer: (ev) => { passingCapture.push(ev); },
    now: fixedNow,
  });
  assert.equal(passingResult.allPass, true, 'passing-only fixture must yield allPass=true');
  assert.equal(passingResult.auditEvents.length, 3, '3 passing categories must emit 3 audit events');
  assert.equal(passingCapture.length, 3, 'writer must be invoked once per passing category');
  assert.match(passingResult.summary, /passed=3/);
  assert.match(passingResult.summary, /proof_or_stop_metadata_changes=1/);
  assert.match(passingResult.summary, /runtime_artifact_changes=1/);
  assert.match(passingResult.summary, /declared_artifact_changes=1/);

  // (4) B-3506 scenario — empty classification → allPass=true, no audit.
  const emptyResult = evaluateDirtyGate(buildClassification([]), {
    storyId: STORY,
    gate: 'test-pre-check',
    writer: null,
    now: fixedNow,
  });
  assert.equal(emptyResult.allPass, true);
  assert.equal(emptyResult.auditEvents.length, 0, 'empty classification must not write audit events');
  assert.equal(emptyResult.summary, 'blocking=0; passed=0');

  // (5) BL21 lacZ scenario — single declared_artifact_changes path passes.
  const BL21 = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
  const bl21Result = evaluateDirtyGate(
    buildClassification([{ category: 'declared_artifact_changes', path: BL21 }]),
    { storyId: STORY, gate: 'done-gate', writer: null, now: fixedNow },
  );
  assert.equal(bl21Result.allPass, true);
  assert.equal(bl21Result.auditEvents.length, 1);
  assert.equal(bl21Result.auditEvents[0].category, 'declared_artifact_changes');
  assert.equal(bl21Result.auditEvents[0].paths[0], BL21);

  // (5b) runtime_artifact_changes solo fixture — preMortem #1 anchor for the
  // smallest non-blocking single-category passing path. Covers CHK-004:edge:0
  // (verificationIntent: "single runtime_artifact_changes path → allPass=true
  // with exactly one audit row, category=runtime_artifact_changes"). Distinct
  // from (5) which covers declared_artifact_changes, and from (3) which mixes
  // all three passing categories.
  const runtimeOnlyPath = '.proof-or-stop/activity.jsonl';
  const runtimeOnlyResult = evaluateDirtyGate(
    buildClassification([{ category: 'runtime_artifact_changes', path: runtimeOnlyPath }]),
    { storyId: STORY, gate: 'done-gate', writer: null, now: fixedNow },
  );
  assert.equal(runtimeOnlyResult.allPass, true, 'solo runtime_artifact_changes must yield allPass=true');
  assert.equal(runtimeOnlyResult.auditEvents.length, 1, 'solo runtime_artifact_changes must emit exactly one audit event');
  assert.equal(runtimeOnlyResult.auditEvents[0].category, 'runtime_artifact_changes');
  assert.equal(runtimeOnlyResult.auditEvents[0].paths[0], runtimeOnlyPath);
  assert.equal(runtimeOnlyResult.auditEvents[0].pathCount, 1);
  assert.match(runtimeOnlyResult.summary, /passed=1/);
  assert.match(runtimeOnlyResult.summary, /runtime_artifact_changes=1/);
  assert.equal(
    Object.keys(runtimeOnlyResult.blockingCounts).length,
    0,
    'solo runtime_artifact_changes must produce zero blocking counts',
  );

  // (6) audit-write-failure → AUDIT WRITE FAILED + allPass forced false.
  // preMortem #2 anchor.
  const failingWriter: AuditWriter = () => { throw new Error('ENOSPC: no space left'); };
  const auditFailResult = evaluateDirtyGate(passingFixture, {
    storyId: STORY,
    gate: 'done-gate',
    writer: failingWriter,
    now: fixedNow,
  });
  assert.equal(auditFailResult.allPass, false, 'writer throw must force allPass=false');
  assert.ok(
    auditFailResult.auditFailure && auditFailResult.auditFailure.startsWith('AUDIT WRITE FAILED:'),
    'auditFailure must surface AUDIT WRITE FAILED prefix',
  );
  assert.match(auditFailResult.auditFailure!, /ENOSPC/);

  // (7) import-isolation grep — preMortem #3 anchor. Category literals must
  // only appear inside `from '../core/dirty-gate-policy.js'` or
  // `from '../core/dirty-worktree.js'` import lines in the two gate consumers.
  // At runtime this smoke runs from dist/tasks/; sources live under src/.
  // Walk up from <pkg>/dist/tasks/ to <pkg>/, then into src/.
  const distTasksDir = ORIGINAL_TASKS_DIR;
  const pkgRoot = resolve(distTasksDir, '..', '..');
  const srcRoot = join(pkgRoot, 'src');
  for (const rel of ['core/done-oracle.ts', 'core/validation-executor.ts']) {
    const filePath = join(srcRoot, rel);
    const src = readFileSync(filePath, 'utf-8');
    for (const cat of DIRTY_WORKTREE_CATEGORIES) {
      // Find all line numbers containing the literal.
      const lines = src.split('\n');
      const offending: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(cat)) continue;
        const trimmed = line.trim();
        // Allow:
        //   - Comments (// or block)
        //   - import lines (single-line or part of a multi-line import block)
        //   - lines referencing the literal inside a comment
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (trimmed.startsWith('import ') || trimmed.includes(' from ')) continue;
        // Inside multi-line import braces: heuristic — line is just a
        // bare identifier (no method call, no string, no =)
        if (/^[A-Za-z_][A-Za-z0-9_]*,?$/.test(trimmed)) continue;
        offending.push(`${rel}:${i + 1}: ${line}`);
      }
      assert.equal(
        offending.length,
        0,
        `inline literal "${cat}" found in ${rel} — must be imported from dirty-gate-policy.ts (B-4b22 preMortem #3)\n${offending.join('\n')}`,
      );
    }
  }

  // (8) defaultAuditWriter happy path — actually append to a tmp file.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-dirty-audit-'));
  try {
    const storyDirRel = '.proof-or-stop/story/actives';
    mkdirSync(join(tmpRoot, storyDirRel, STORY), { recursive: true });
    const writer = defaultAuditWriter(tmpRoot, storyDirRel, STORY);
    const result = evaluateDirtyGate(passingFixture, {
      storyId: STORY,
      gate: 'validate-side-effect',
      writer,
      now: fixedNow,
    });
    assert.equal(result.allPass, true);
    const jsonlPath = join(tmpRoot, storyDirRel, STORY, 'process-events.jsonl');
    assert.ok(existsSync(jsonlPath), 'process-events.jsonl must be created by defaultAuditWriter');
    const persisted = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(persisted.length, 3, 'must write one JSONL row per passing category');
    for (const line of persisted) {
      const ev = JSON.parse(line);
      assert.equal(ev.type, 'dirty_gate_audit');
      assert.equal(ev.storyId, STORY);
      assert.equal(ev.gate, 'validate-side-effect');
      assert.equal(ev.timestamp, fixedNow());
      assert.ok(typeof ev.reason === 'string' && ev.reason.length > 0);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  // (9) path truncation — >5 paths in a passing category truncate to 5 with
  // pathCount preserved.
  const manyPaths = Array.from({ length: 8 }, (_, i) => `.proof-or-stop/story/actives/B-x/file-${i}.json`);
  const manyFixture = buildClassification(
    manyPaths.map((p) => ({ category: 'proof_or_stop_metadata_changes', path: p })),
  );
  const truncResult = evaluateDirtyGate(manyFixture, {
    storyId: STORY,
    gate: 'done-gate',
    writer: null,
    now: fixedNow,
  });
  assert.equal(truncResult.allPass, true);
  assert.equal(truncResult.auditEvents.length, 1);
  assert.equal(truncResult.auditEvents[0].pathCount, 8);
  assert.equal(truncResult.auditEvents[0].paths.length, AUDIT_PATH_SAMPLE_LIMIT, 'paths must be truncated to 5');
  assert.equal(truncResult.auditEvents[0].paths.length, 5);
}
