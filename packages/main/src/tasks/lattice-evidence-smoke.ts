#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import {
  buildEvidenceManifest,
  inspectEvidenceManifest,
  type EvidenceInspection,
  type EvidenceManifest,
} from '../core/lattice-evidence.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitPaths(cwd: string, message: string, paths: string[]): string {
  git(cwd, ['add', ...paths]);
  git(cwd, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
  }, null, 2));
}

function seedStory(store: StoryStore, headHash: string, materialHash: string): void {
  const now = '2026-06-02T00:00:00.000Z';
  const storyFilesHash = 'f'.repeat(64);
  const testEvidence: VerificationEvidence & {
    receiptRef: string;
    redaction: { applied: boolean; secretsRedacted: boolean; notes: string[] };
  } = {
    intentRef: 'CHK-005:happy:0',
    kind: 'integration_test',
    command: 'npm run test:lattice-handoff-smoke',
    file: 'packages/main/src/core/lattice-handoff.ts',
    result: 'pass',
    note: 'Handoff accept/resume evidence.',
    headHash,
    materialHash,
    storyFilesHash,
    timestamp: now,
    receiptRef: 'local-runner-receipt-ref',
    redaction: {
      applied: true,
      secretsRedacted: true,
      notes: ['token-like transcript values redacted'],
    },
  };
  const failedProofEvidence: VerificationEvidence = {
    intentRef: 'CHK-006:local-admissibility-fail:custom',
    kind: 'manual_transcript',
    command: 'lattice conduit_status --json --storyId=B-12f3',
    result: 'fail',
    verdict: 'blocked_classified',
    note: 'Local admissibility proof remains blocked until gate evidence is fresh and scoped.',
    headHash,
    materialHash,
    storyFilesHash,
    timestamp: now,
  };
  const waiverEvidence: VerificationEvidence = {
    intentRef: 'CHK-006:edge:0',
    kind: 'waiver',
    command: 'waiver for lifecycle coverage only',
    result: 'pass',
    verdict: 'blocked_classified',
    waiverType: 'permanent',
    note: 'Lifecycle coverage waiver remains distinct from the failed Authority proof ref.',
    headHash,
    materialHash,
    storyFilesHash,
    timestamp: now,
  };
  const story: StoryInfo = {
    storyId: 'B-evidence',
    name: 'evidence-smoke',
    title: 'Evidence portability smoke story',
    description: 'Smoke story for portable evidence manifests.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-005',
        title: 'Accept handoff',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationEvidence: [testEvidence],
      },
      {
        id: 'CHK-006',
        title: 'Inspect evidence freshness',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationEvidence: [
          {
            intentRef: 'CHK-006:happy:0',
            kind: 'manual_transcript',
            file: 'transcripts/evidence-smoke.md',
            result: 'pass',
            note: 'Transcript reference for portability smoke.',
            headHash,
            materialHash,
            storyFilesHash,
            timestamp: now,
          },
          failedProofEvidence,
          waiverEvidence,
        ],
      },
    ],
  };
  store.writeStory('B-evidence', story);
  store.writeChecklist('B-evidence', checklist);
}

function assertEvidenceRefSemantics(refs: EvidenceInspection['evidenceRefs']): void {
  const failedProof = refs.find(ref => ref.intentRef === 'CHK-006:authority-proof-fail:custom');
  assert.ok(failedProof, 'custom failed proof evidence ref is projected');
  assert.equal(failedProof.result, 'fail');
  assert.equal(failedProof.verdict, 'blocked_classified');
  assert.match(failedProof.note ?? '', /receiptVerified=false/);
  assert.equal(failedProof.waiverType, undefined);

  const waiver = refs.find(ref => ref.intentRef === 'CHK-006:edge:0');
  assert.ok(waiver, 'waiver evidence ref is projected');
  assert.equal(waiver.kind, 'waiver');
  assert.equal(waiver.result, 'pass');
  assert.equal(waiver.verdict, 'blocked_classified');
  assert.equal(waiver.waiverType, 'permanent');
  assert.match(waiver.note ?? '', /distinct from the failed Authority proof ref/);
}

function assertManifestFresh(manifest: EvidenceManifest, headHash: string, materialHash: string): void {
  assert.equal(manifest.schemaVersion, 'lattice.evidence_manifest.v1');
  assert.equal(manifest.storyId, 'B-evidence');
  assert.equal(manifest.sourceHost, 'codex');
  assert.equal(manifest.headHash, headHash);
  assert.equal(manifest.materialHash, materialHash);
  assert.equal(manifest.freshness.status, 'fresh');
  assert.deepEqual(manifest.freshness.staleRefs, []);
  assert.equal(manifest.authority.authorityChanged, false);
  assert.equal(manifest.authority.productionDone, false);
  assert.deepEqual(manifest.authority.receiptRefs, ['local-runner-receipt-ref']);
  assert.equal(manifest.authority.receiptRefsVerified, false);
  assert.ok(manifest.authority.notes.some(note => /unverified local/.test(note)));
  assert.equal(manifest.redaction.applied, true);
  assert.equal(manifest.redaction.secretsRedacted, true);
  assert.ok(manifest.redaction.notes.includes('token-like transcript values redacted'));
  assert.ok(manifest.transcriptRefs.includes('transcripts/evidence-smoke.md'), 'manifest carries transcript refs');
  assert.ok(manifest.testRefs.includes('command:npm run test:lattice-handoff-smoke'), 'manifest carries test command refs');
  assert.ok(manifest.evidenceRefs.some(ref => ref.receiptRefs.includes('local-runner-receipt-ref')), 'manifest carries receipt lineage per evidence ref');
  assert.ok(manifest.evidenceRefs.some(ref => ref.redaction.secretsRedacted), 'manifest carries redaction metadata per evidence ref');
  assert.ok(manifest.evidenceRefs.every(ref => ref.storyFilesHash === 'f'.repeat(64)), 'manifest preserves storyFilesHash per evidence ref');
  assert.ok(manifest.evidenceRefs.every(ref => ref.freshness.status === 'fresh'), 'all refs start fresh');
  assertEvidenceRefSemantics(manifest.evidenceRefs);
  assert.equal(manifest.refreshGuidance.refreshOnlyProvidesGuidance, true);
  assert.equal(manifest.refreshGuidance.authorityChanged, false);
}

function assertInspectionStale(inspection: EvidenceInspection, driftHead: string): void {
  assert.equal(inspection.schemaVersion, 'lattice.evidence_inspect.v1');
  assert.equal(inspection.storyId, 'B-evidence');
  assert.equal(inspection.sourceHost, 'codex');
  assert.equal(inspection.headHash, driftHead);
  assert.equal(inspection.freshness.status, 'stale');
  assert.ok(inspection.freshness.staleRefs.includes('CHK-005:happy:0'), 'test evidence becomes stale after material drift');
  assert.ok(inspection.freshness.staleRefs.includes('CHK-006:happy:0'), 'transcript evidence becomes stale after material drift');
  assert.ok(inspection.freshness.staleRefs.includes('CHK-006:authority-proof-fail:custom'), 'failed proof evidence becomes stale after material drift');
  assert.ok(inspection.freshness.staleRefs.includes('CHK-006:edge:0'), 'waiver evidence becomes stale after material drift');
  assert.equal(inspection.authority.authorityChanged, false);
  assert.equal(inspection.authority.productionDone, false);
  assert.deepEqual(inspection.authority.receiptRefs, ['local-runner-receipt-ref']);
  assert.equal(inspection.authority.receiptRefsVerified, false);
  assert.equal(inspection.redaction.applied, true);
  assert.equal(inspection.redaction.secretsRedacted, true);
  assert.ok(inspection.redaction.notes.includes('token-like transcript values redacted'));
  assert.equal(inspection.refreshGuidance.refreshOnlyProvidesGuidance, true);
  assert.equal(inspection.refreshGuidance.authorityChanged, false);
  assert.ok(inspection.refreshGuidance.guidance.includes('does not refresh hashes'), 'refresh is guidance-only');
  assert.ok(inspection.refreshGuidance.recommendedCommands.includes('npm run test:lattice-handoff-smoke'), 'stale test command is suggested');
  assertEvidenceRefSemantics(inspection.evidenceRefs);
}

const root = mkdtempSync(join(tmpdir(), 'lattice-evidence-'));
try {
  writeConfig(root);
  git(root, ['init']);
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  const headHash = commitPaths(root, 'base', ['lattice.config.json', 'packages/main/src/base.ts']);
  const materialHash = currentMaterialHash(root);
  assert.ok(materialHash, 'material hash should be available in git repo');

  resetConfigCache();
  const store = new StoryStore(root);
  seedStory(store, headHash, materialHash);

  const manifest = buildEvidenceManifest(store, root, { storyId: 'B-evidence', sourceHost: 'codex' });
  assertManifestFresh(manifest, headHash, materialHash);

  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'evidence_manifest'), 'MAIN_TOOLS exposes evidence_manifest');
  assert.ok(MAIN_TOOLS.some(tool => tool.name === 'evidence_inspect'), 'MAIN_TOOLS exposes evidence_inspect');
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assert.equal(registry.has('evidence_manifest'), true, 'registry exposes evidence_manifest handler');
  assert.equal(registry.has('evidence_inspect'), true, 'registry exposes evidence_inspect handler');
  assertManifestFresh(registry.get('evidence_manifest')!({
    storyId: 'B-evidence',
    sourceHost: 'codex',
    format: 'json',
  }) as EvidenceManifest, headHash, materialHash);

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const manifestPath = join(root, 'evidence-manifest.json');
  execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'evidence_manifest',
    '--storyId=B-evidence',
    '--sourceHost=codex',
    `--output=${manifestPath}`,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertManifestFresh(JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest, headHash, materialHash);
  assert.throws(
    () => registry.get('evidence_manifest')!({
      storyId: 'B-evidence',
      sourceHost: 'codex',
      output: manifestPath,
    }),
    /refusing to overwrite existing file/,
    'evidence_manifest output must be no-overwrite',
  );

  write(root, 'packages/main/src/base.ts', 'export const base = false;\n');
  const driftHead = commitPaths(root, 'material drift', ['packages/main/src/base.ts']);
  const inspected = inspectEvidenceManifest(manifest, root);
  assertInspectionStale(inspected, driftHead);

  const inspectStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'evidence_inspect',
    `--file=${manifestPath}`,
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertInspectionStale(JSON.parse(inspectStdout) as EvidenceInspection, driftHead);

  const storyInspectStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'evidence_inspect',
    '--storyId=B-evidence',
    '--sourceHost=codex',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertInspectionStale(JSON.parse(storyInspectStdout) as EvidenceInspection, driftHead);

  const inspectPath = join(root, 'evidence-inspect.json');
  registry.get('evidence_inspect')!({ file: manifestPath, output: inspectPath });
  assertInspectionStale(JSON.parse(readFileSync(inspectPath, 'utf8')) as EvidenceInspection, driftHead);
  assert.throws(
    () => registry.get('evidence_inspect')!({ file: manifestPath, output: inspectPath }),
    /refusing to overwrite existing file/,
    'evidence_inspect output must be no-overwrite',
  );

  const storedEvidence = store.readChecklist('B-evidence').items.flatMap(item => item.verificationEvidence ?? []);
  assert.ok(storedEvidence.every(evidence => evidence.headHash === headHash), 'inspect must not refresh stored evidence headHash');
  assert.ok(storedEvidence.every(evidence => evidence.materialHash === materialHash), 'inspect must not refresh stored evidence materialHash');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ lattice evidence smoke passed');
