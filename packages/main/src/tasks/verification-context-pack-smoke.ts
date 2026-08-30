#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { isCommandAllowed } from '../core/config.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createVerificationContextPackHandlers } from '../handlers/verification-context-pack.js';
import {
  allContextPackRequiredRefs,
  digestCommand,
  digestVerificationContextPack,
} from '../core/authority-contracts.js';
import { EvidenceCollector } from '../core/evidence-collector.js';
import {
  createVerificationContextPack,
  createVerificationContextPackExpansion,
  parseGitDiffHunks,
} from '../core/verification-context-pack.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function schemaFor(name: string) {
  const tool = MAIN_TOOLS.find(candidate => candidate.name === name);
  assert.ok(tool, `missing tool schema for ${name}`);
  return z.object(tool.schema);
}

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-vcp-'));
git(root, ['init']);
git(root, ['config', 'user.email', 'proofOrStop@example.test']);
git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
writeFileSync(join(root, 'alpha.ts'), [
  'export function alpha() {',
  '  return 1;',
  '}',
  '',
].join('\n'));
git(root, ['add', 'alpha.ts']);
git(root, ['commit', '-m', 'initial']);
writeFileSync(join(root, 'alpha.ts'), [
  'export function alpha() {',
  '  const value = 2;',
  '  return value;',
  '}',
  '',
].join('\n'));
writeFileSync(join(root, 'beta.ts'), [
  'export function beta() {',
  '  return alpha();',
  '}',
  '',
].join('\n'));

const result = createVerificationContextPack({
  root,
  producerRunId: 'run-producer-1',
  storyId: 'B-vcp',
  checklistItemIds: ['CHK-001'],
  testIntentRefs: ['CHK-001:happy:0'],
  requiredCommands: [{ command: ['npm', 'run', 'test:verification-context-pack'], required: true }],
  oracleRefs: ['oracle:unit'],
  tokenBudget: 1000,
});

assert.equal(result.pack.producerRunId, 'run-producer-1');
assert.deepEqual(result.pack.changedFiles, ['alpha.ts', 'beta.ts']);
assert.ok((result.pack.changedHunks ?? []).length >= 1);
assert.ok((result.pack.sourceSnippets ?? []).length >= 1);
assert.equal(result.packDigest, digestVerificationContextPack(result.pack));
assert.ok(allContextPackRequiredRefs(result.pack).includes('file:alpha.ts'));
assert.ok(allContextPackRequiredRefs(result.pack).includes('file:beta.ts'));
assert.ok(allContextPackRequiredRefs(result.pack).some(ref => ref.startsWith('hunk:alpha.ts:')));
assert.ok(allContextPackRequiredRefs(result.pack).some(ref => ref.startsWith('hunk:beta.ts:')));
assert.ok(allContextPackRequiredRefs(result.pack).includes(`command:${digestCommand(['npm', 'run', 'test:verification-context-pack'])}`));

const truncatedResult = createVerificationContextPack({
  root,
  producerRunId: 'run-producer-1',
  storyId: 'B-vcp',
  tokenBudget: 1,
});
assert.equal(truncatedResult.pack.truncated, true);
assert.ok(truncatedResult.pack.limitations?.includes('token budget truncated source snippets'));

const parsed = parseGitDiffHunks(result.diffText);
assert.deepEqual(parsed.map(h => h.hunkRef), (result.pack.changedHunks ?? []).map(h => h.hunkRef));
assert.ok((result.pack.changedHunks ?? []).every(hunk => Boolean(hunk.patchHash && hunk.patchHash.length > 0)));

const multiTrackedRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-vcp-multi-'));
git(multiTrackedRoot, ['init']);
git(multiTrackedRoot, ['config', 'user.email', 'proofOrStop@example.test']);
git(multiTrackedRoot, ['config', 'user.name', 'Proof-or-Stop Smoke']);
writeFileSync(join(multiTrackedRoot, 'alpha.ts'), 'export const alpha = 1;\n');
writeFileSync(join(multiTrackedRoot, 'beta.ts'), 'export const beta = 1;\n');
git(multiTrackedRoot, ['add', 'alpha.ts', 'beta.ts']);
git(multiTrackedRoot, ['commit', '-m', 'initial']);
writeFileSync(join(multiTrackedRoot, 'alpha.ts'), 'export const alpha = 2;\n');
writeFileSync(join(multiTrackedRoot, 'beta.ts'), 'export const beta = 2;\n');

const multiTrackedPack = createVerificationContextPack({
  root: multiTrackedRoot,
  producerRunId: 'run-producer-multi',
  storyId: 'B-vcp-multi',
});
assert.deepEqual(
  (multiTrackedPack.pack.changedHunks ?? []).map(hunk => hunk.hunkRef),
  ['alpha.ts:1', 'beta.ts:1'],
);
assert.ok(
  (multiTrackedPack.pack.changedHunks ?? []).every(hunk => Boolean(hunk.patchHash && hunk.patchHash.length > 0)),
  'multi-file diff should not emit empty patch hashes',
);

assert.equal(schemaFor('verification_context_pack_create').safeParse({
  producerRunId: 'run-producer-1',
  requiredCommands: [{ command: ['npm', 'test'], required: true }],
}).success, true);
assert.equal(schemaFor('verification_context_pack_expand').safeParse({
  parentPack: result.pack,
  expansionReason: 'Need adjacent caller context for changed alpha behavior',
  impactedSymbols: [{
    symbolRef: 'beta.ts:beta:1',
    file: 'beta.ts',
    symbolName: 'beta',
    line: 1,
  }],
  dependencyEdges: [{
    sourceRef: 'symbol:beta.ts:beta:1',
    targetRef: 'symbol:alpha.ts:alpha:1',
    edgeType: 'calls',
  }],
  sourceSnippets: [{
    snippetRef: 'beta.ts:1-3',
    file: 'beta.ts',
    startLine: 1,
    endLine: 3,
    contentHash: 'beta-snippet',
    content: 'export function beta() {\n  return alpha();\n}',
  }],
}).success, true);

assert.throws(
  () => createVerificationContextPackExpansion(result.pack, { expansionReason: 'short' }),
  /expansionReason/,
);
const expansion = createVerificationContextPackExpansion(result.pack, {
  expansionReason: 'Need adjacent caller context for changed alpha behavior',
  impactedFiles: ['beta.ts'],
  requiredRefs: ['file:beta.ts'],
});
assert.equal(expansion.parentPackDigest, result.packDigest);
assert.ok(expansion.pack.impactedFiles?.includes('beta.ts'));

assert.ok(MAIN_TOOLS.some(tool => tool.name === 'verification_context_pack_create'));
assert.ok(MAIN_TOOLS.some(tool => tool.name === 'verification_context_pack_expand'));
assert.equal(isCommandAllowed('verification_context_pack_create', 'DEV'), true);
assert.equal(isCommandAllowed('verification_context_pack_expand', 'REVIEW'), true);

const handlers = createVerificationContextPackHandlers({ root } as any);
const handlerResult = handlers.verification_context_pack_create({
  producerRunId: 'run-producer-1',
  storyId: 'B-vcp',
  requiredCommands: [{ command: ['npm', 'run', 'build'], required: true }],
});
assert.equal(handlerResult.packDigest, digestVerificationContextPack(handlerResult.pack));
assert.deepEqual(handlerResult.pack.requiredCommands, [{ command: ['npm', 'run', 'build'], required: true }]);
assert.equal(handlerResult.summary.changedFiles, handlerResult.pack.changedFiles?.length ?? 0);
assert.equal(handlerResult.summary.changedHunks, handlerResult.pack.changedHunks?.length ?? 0);
assert.equal(handlerResult.summary.sourceSnippets, handlerResult.pack.sourceSnippets?.length ?? 0);
assert.equal(handlerResult.summary.estimatedTokens, handlerResult.pack.estimatedTokens ?? 0);
assert.equal(handlerResult.summary.truncated, handlerResult.pack.truncated ?? false);

const buildCommandRef = `command:${digestCommand(['npm', 'run', 'build'])}`;
assert.ok(allContextPackRequiredRefs(handlerResult.pack).includes(buildCommandRef));

const handlerExpansion = handlers.verification_context_pack_expand({
  parentPack: handlerResult.pack,
  expansionReason: 'Need adjacent caller and dependency context for changed alpha behavior',
  impactedFiles: ['beta.ts'],
  impactedSymbols: [{
    symbolRef: 'beta.ts:beta:1',
    file: 'beta.ts',
    symbolName: 'beta',
    line: 1,
  }],
  dependencyEdges: [{
    sourceRef: 'symbol:beta.ts:beta:1',
    targetRef: 'symbol:alpha.ts:alpha:1',
    edgeType: 'calls',
  }],
  sourceSnippets: [{
    snippetRef: 'beta.ts:1-3',
    file: 'beta.ts',
    startLine: 1,
    endLine: 3,
    contentHash: 'beta-snippet',
    content: 'export function beta() {\n  return alpha();\n}',
  }],
  requiredRefs: ['symbol:beta.ts:beta:1'],
  tokenBudget: 2000,
});
assert.equal(handlerExpansion.parentPackDigest, handlerResult.packDigest);
assert.ok((handlerExpansion.pack.impactedSymbols ?? []).some(symbol => symbol.symbolRef === 'beta.ts:beta:1'));
assert.ok((handlerExpansion.pack.dependencyEdges ?? []).some(edge => edge.edgeType === 'calls'));
assert.ok((handlerExpansion.pack.sourceSnippets ?? []).some(snippet => snippet.snippetRef === 'beta.ts:1-3'));
assert.ok((handlerExpansion.pack.requiredRefs ?? []).includes('symbol:beta.ts:beta:1'));
assert.ok((handlerExpansion.pack.estimatedTokens ?? 0) > (handlerResult.pack.estimatedTokens ?? 0));
assert.equal(handlerExpansion.pack.truncated, false);

const limitedExpansion = handlers.verification_context_pack_expand({
  parentPack: handlerResult.pack,
  expansionReason: 'Need more context but budget should truncate the appended snippet',
  sourceSnippets: [{
    snippetRef: 'beta.ts:1-20',
    file: 'beta.ts',
    startLine: 1,
    endLine: 20,
    contentHash: 'beta-large-snippet',
    content: 'x'.repeat(400),
  }],
  tokenBudget: handlerResult.pack.estimatedTokens ?? 0,
});
assert.equal(limitedExpansion.pack.truncated, true);
assert.ok(limitedExpansion.pack.limitations?.includes('token budget truncated source snippets'));

assert.throws(
  () => handlers.verification_context_pack_expand({
    parentPack: {
      packId: 'broken-pack',
    } as any,
    expansionReason: 'Need malformed parent to fail closed before expansion',
  }),
  /parentPack.*invalid/,
);

const collector = new EvidenceCollector();
const evidence = collector.collect({
  evidenceId: 'EV-vcp',
  projectId: 'project',
  storyId: 'B-vcp',
  producerActorId: 'verifier-1',
  producerRunId: 'run-producer-1',
  verifierRunId: 'run-verifier-1',
  verificationContextPack: handlerResult.pack,
  command: 'npm test',
  exitCode: 0,
  nonce: 'nonce-vcp',
  createdAt: '2026-05-20T00:00:00Z',
});
assert.equal(evidence.verificationContextPackId, handlerResult.pack.packId);
assert.equal(evidence.verificationContextPackDigest, handlerResult.packDigest);
assert.ok(evidence.coveredRefs.includes(buildCommandRef));
assert.ok(evidence.inspectedPackRefs.includes(buildCommandRef));
assert.deepEqual(evidence.inspectedPackRefs, allContextPackRequiredRefs(handlerResult.pack));

const deletionRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-vcp-delete-'));
git(deletionRoot, ['init']);
git(deletionRoot, ['config', 'user.email', 'proofOrStop@example.test']);
git(deletionRoot, ['config', 'user.name', 'Proof-or-Stop Smoke']);
writeFileSync(join(deletionRoot, 'gamma.ts'), 'export const gamma = 1;\n');
git(deletionRoot, ['add', 'gamma.ts']);
git(deletionRoot, ['commit', '-m', 'initial']);
rmSync(join(deletionRoot, 'gamma.ts'));

const deletionPack = createVerificationContextPack({
  root: deletionRoot,
  producerRunId: 'run-producer-delete',
  storyId: 'B-vcp-delete',
});
assert.deepEqual(deletionPack.pack.changedFiles, ['gamma.ts']);
assert.ok((deletionPack.pack.changedHunks ?? []).length >= 1);
assert.ok((deletionPack.pack.changedHunks ?? []).every(hunk => hunk.file === 'gamma.ts'));
assert.ok((deletionPack.pack.changedHunks ?? []).every(hunk => !hunk.hunkRef.endsWith(':0')));
assert.ok((deletionPack.pack.changedHunks ?? []).every(hunk => Boolean(hunk.patchHash && hunk.patchHash.length > 0)));
assert.ok(parseGitDiffHunks(deletionPack.diffText).every(hunk => hunk.file === 'gamma.ts' && !hunk.hunkRef.endsWith(':0')));
assert.ok((deletionPack.pack.sourceSnippets ?? []).some(snippet => snippet.file === 'gamma.ts'));
assert.ok((deletionPack.pack.sourceSnippets ?? []).some(snippet => snippet.content?.includes('export const gamma = 1;')));

console.log('verification context pack smoke passed');
