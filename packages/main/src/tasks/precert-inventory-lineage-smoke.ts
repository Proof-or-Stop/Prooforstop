#!/usr/bin/env node
/**
 * Lab precert-inventory-lineage: in run 7 (2026-09-30) a BLOCKED certification_window_begin
 * auto-committed its projection after review_inventory_finalize, and every later begin refused
 * "Inventory receipt is not on the current headHash lineage". A signed inventory receipt must
 * stay admissible across PoS metadata-only commits (code identity is re-checked at consume).
 * Original note: a PRE_CERT cheap-check receipt must stay current
 * across PoS metadata-only commits (a BLOCKED certification_window_begin
 * auto-commits its projection), because the code identity it attests
 * (materialHash + storyFilesHash) is unchanged. A code change must still
 * invalidate it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { StoryStore } from '../core/store.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { createCertificationWindowHandlers } from '../handlers/certification-window.js';
import { createVerifierHandlers } from '../handlers/verifier.js';
import { buildRoutineValidationIdentity } from '../core/validation-evidence-reuse.js';
import {
  INVENTORY_COMPLETENESS_AUTHORITY,
  PRE_CERT_CHEAP_CHECK_REQUIRED,
  PRECERT_CHEAP_CHECK_AUTHORITY,
  PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
  setReviewInventoryAdmitApisForTest,
  withSignedPrecertCheapCheckReceipt,
  type ReviewInventoryAdmitApis,
} from '../core/certification-window.js';

function signedFastCheapReceipt(args: {
  storyId: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  full?: boolean | string | null;
  focus?: string | null;
  commandCount?: number;
}) {
  const commandCount = args.commandCount ?? 1;
  const identity = buildRoutineValidationIdentity({
    projectRoot: process.cwd(),
    sourceKind: 'configured',
    sourceInputs: { fixture: 'pre-cert-cheap-check' },
    commands: Array.from({ length: commandCount }, (_, index) => ({
      label: `fast-${index + 1}`,
      command: 'node',
      args: ['--version'],
      timeoutMs: 15_000,
      focus: ['fast'],
    })),
    ...(args.full === undefined || args.full === null ? {} : { full: args.full }),
    ...(args.focus === undefined || args.focus === null ? { focus: 'fast' } : { focus: args.focus }),
    profile: 'standard',
    verificationPolicyInputs: { fixture: 'pre-cert-cheap-check' },
  });
  const unsigned = {
    schemaVersion: PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA as typeof PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
    receiptId: `${args.storyId}:CHEAP-CHECK-001`,
    storyId: args.storyId,
    authority: PRECERT_CHEAP_CHECK_AUTHORITY as typeof PRECERT_CHEAP_CHECK_AUTHORITY,
    result: 'PASS' as const,
    routineValidationIdentity: identity,
    commandExecution: {
      schema: 'proofOrStop.routine-validation-command-execution' as const,
      version: 1 as const,
      status: 'PASS' as const,
      complete: true,
      commandCount,
      requiredFailureCount: 0,
      optionalFailureCount: 0,
    },
    headHash: args.headHash,
    materialHash: args.materialHash,
    storyFilesHash: args.storyFilesHash,
    createdAt: '2026-08-20T00:00:00.000Z',
  };
  return withSignedPrecertCheapCheckReceipt(unsigned);
}

function makeStore(root: string, storyId: string, phase: 'DEV' | 'REVIEW' | 'TEST' = 'DEV'): StoryStore {
  const store = new StoryStore(root);
  mkdirSync(join(root, '.proof-or-stop', 'story', 'actives', storyId), { recursive: true });
  store.writeStory(storyId, {
    storyId,
    name: 'certification-window-smoke',
    title: 'Certification window smoke',
    description: 'Smoke test story',
    type: 'feature',
    phase,
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    events: [],
  });
  store.writeChecklist(storyId, { items: [] });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'fixture-owner', cwd: root });
  return store;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeGitRoot(): string {
  const gitRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-certification-window-git-'));
  git(gitRoot, ['init', '-b', 'main']);
  git(gitRoot, ['config', 'user.email', 'cert-window@example.test']);
  git(gitRoot, ['config', 'user.name', 'cert-window']);
  writeFileSync(join(gitRoot, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
    validate: { commands: [{ label: 'fast-fixture', command: 'node', args: ['--version'], focus: ['fast'], timeoutMs: 15000 }] },
  }));
  writeFileSync(join(gitRoot, 'README.md'), 'certification window smoke\n');
  git(gitRoot, ['add', 'proof-or-stop.config.json', 'README.md']);
  git(gitRoot, ['commit', '-m', 'init']);
  return gitRoot;
}

function mockInventoryApis(args: {
  storyId: string;
  materialHash: string;
  storyFilesHash: string;
  headHash: string;
  otherStoryId?: string;
  driftedHeadHash?: string;
  driftedMaterialHash?: string;
  completenessOnly?: boolean;
  authority?: string;
  authorizesTest?: boolean;
  verifyEpoch?: boolean;
  verifyReceipt?: boolean;
  consumeError?: string;
  epochConsumed?: boolean;
  receiptConsumed?: boolean;
  receiptInvalidated?: boolean;
  downgradeOnConsume?: boolean;
  beforeConsumeContext?: () => void;
}): { apis: ReviewInventoryAdmitApis; consumed: string[] } {
  const consumed: string[] = [];
  const inventoryStoryId = args.otherStoryId ?? args.storyId;
  const headHash = args.driftedHeadHash ?? args.headHash;
  const materialHash = args.driftedMaterialHash ?? args.materialHash;
  let finalizedReadCount = 0;
  const pair = (completenessOnly: boolean) => {
    const requiredLanes = completenessOnly ? [] : ['lattice-review-contract', 'lattice-review-quality'];
    const finalWave = completenessOnly ? [] : [{
    lanes: requiredLanes.map(lane => ({
      lane,
      terminal: 'pass',
      evidenceIds: [`${lane}:PASS-001`],
      coverageDigest: `${lane}-coverage`,
    })),
    newVerifiedFindingCount: 0,
    criticDigest: 'critic-digest',
    saturated: true,
  }];
    return {
      epoch: {
        epochId: 'epoch-1',
        storyId: inventoryStoryId,
        reviewRound: 'round-1',
        state: 'FINALIZED',
        receiptId: 'INV-1',
        cutoff: { headHash, materialHash, storyFilesHash: args.storyFilesHash },
        requiredLanes,
        waves: finalWave,
        ...(args.epochConsumed ? { consumedAt: '2026-08-20T00:02:00.000Z' } : {}),
      },
      receipt: {
        receiptId: 'INV-1',
        epochId: 'epoch-1',
        storyId: inventoryStoryId,
        reviewRound: 'round-1',
        authority: args.authority ?? INVENTORY_COMPLETENESS_AUTHORITY,
        authorizesTest: args.authorizesTest ?? false,
        cutoff: { headHash, materialHash, storyFilesHash: args.storyFilesHash },
        requiredLanes,
        waveCount: finalWave.length,
        saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
        scopeDigest: 'scope-digest',
        findingSetDigest: 'finding-set-digest',
        coverageDigest: 'coverage-digest',
        ...(args.receiptConsumed ? { consumedAt: '2026-08-20T00:02:00.000Z' } : {}),
        ...(args.receiptInvalidated ? { invalidatedAt: '2026-08-20T00:02:00.000Z' } : {}),
      },
    };
  };
  const apis: ReviewInventoryAdmitApis = {
    finalizedUnconsumedReviewInventory: () => pair(
      Boolean(args.completenessOnly || (args.downgradeOnConsume && finalizedReadCount++ > 0)),
    ),
    consumeReviewInventoryCompletenessReceipt: (_store, _storyId, _reviewRound, _cutoff, validateInventoryContext) => {
      args.beforeConsumeContext?.();
      validateInventoryContext?.();
      if (args.consumeError) throw new Error(args.consumeError);
      consumed.push('INV-1');
      return 'INV-1';
    },
    verifyReviewInventoryEpoch: () => args.verifyEpoch ?? true,
    verifyReviewInventoryReceipt: () => args.verifyReceipt ?? true,
    isInventoryCompletenessOnlyReceipt: (epoch) => (epoch as { requiredLanes?: string[] }).requiredLanes?.length === 0,
  };
  return { apis, consumed };
}

function beginCaught(handlers: ReturnType<typeof createCertificationWindowHandlers>, id: string): string {
  try {
    return handlers.certification_window_begin({ storyId: id });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function writeCheapCheckConfig(dir: string): { fastMarker: string; fullMarker: string } {
  const fastMarker = join(dir, '.proof-or-stop', 'runtime', 'FAST_FOCUSED_RAN');
  const fullMarker = join(dir, '.proof-or-stop', 'runtime', 'FULL_UNSCOPED_RAN');
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    storyPrefix: 'B',
    validate: {
      commands: [
        {
          label: 'fast-focused-detector',
          command: 'node',
          args: ['-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(join(dir, '.proof-or-stop', 'runtime'))},{recursive:true});fs.writeFileSync(${JSON.stringify(fastMarker)}, '1')`],
          timeoutMs: 15_000,
          focus: ['fast'],
        },
        {
          label: 'unscoped-detector',
          command: 'node',
          args: ['-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(join(dir, '.proof-or-stop', 'runtime'))},{recursive:true});fs.writeFileSync(${JSON.stringify(fullMarker)}, '1')`],
          timeoutMs: 15_000,
        },
      ],
    },
  }));
  git(dir, ['add', 'proof-or-stop.config.json']);
  git(dir, ['commit', '-m', 'cheap check validator config']);
  return { fastMarker, fullMarker };
}



async function scenario(storyId: string, followUp: (root: string, store: StoryStore) => void): Promise<string> {
  const root = makeGitRoot();
  writeCheapCheckConfig(root);
  const store = makeStore(root, storyId);
  store.writeChecklist(storyId, { items: [] });
  store.writeTestEvidence(storyId, {
    command: `proof-or-stop validate --story=${storyId} --json`,
    output: '{"status":"pass","allPass":true}',
    result: 'PASS',
    timestamp: '2026-08-20T00:00:00.000Z',
    headHash: currentGitHead(root)!,
    materialHash: currentMaterialHash(root, 'HEAD', root)!,
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)!,
  });
  const ctx = { store, root, scanRoot: join(root, 'packages', 'main'), log: () => {} };
  // Inventory finalized at the current head, before any certification attempt.
  const mock = mockInventoryApis({
    storyId,
    headHash: currentGitHead(root)!,
    materialHash: currentMaterialHash(root, 'HEAD', root)!,
    storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)!,
  });
  setReviewInventoryAdmitApisForTest(mock.apis);
  followUp(root, store);
  const cheap = JSON.parse(await createVerifierHandlers(ctx).validate({ storyId, focus: 'fast', json: true }));
  assert.equal(cheap.precertCheapCheckReceipt?.authority, PRECERT_CHEAP_CHECK_AUTHORITY, 'fixture must mint a cheap receipt');
  return beginCaught(createCertificationWindowHandlers(ctx), storyId);
}

// 1. A blocked begin's own projection commit (an unlisted metadata path) must not strand the inventory receipt.
const metaStory = 'B-inv-meta';
const afterMetadata = await scenario(metaStory, (root, store) => {
  const marker = join(store.storyDirPath(metaStory), 'blocked-projection.json');
  writeFileSync(marker, '{"state":"BLOCKED"}\n');
  git(root, ['add', marker]);
  git(root, ['commit', '-m', `proof-or-stop: record ${metaStory} certification_window_begin metadata`]);
});
assert.doesNotMatch(afterMetadata, /not on the current headHash lineage/,
  `inventory receipt stranded by a metadata-only commit:\n${afterMetadata}`);
assert.match(afterMetadata, /State: ADMITTED/, afterMetadata);

// 2. A code commit after the inventory receipt must still refuse admission.
const codeStory = 'B-inv-code';
const afterCode = await scenario(codeStory, root => {
  writeFileSync(join(root, 'README.md'), 'changed code\n');
  git(root, ['commit', '-am', 'code change']);
});
assert.doesNotMatch(afterCode, /State: ADMITTED/, 'a code change must not admit a stale inventory receipt');

setReviewInventoryAdmitApisForTest(undefined);
console.log('precert-inventory-lineage-smoke: PASS');
