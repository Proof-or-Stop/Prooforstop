#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCommandAllowed } from '../core/config.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createVerificationContextPackHandlers } from '../handlers/verification-context-pack.js';
import {
  allContextPackRequiredRefs,
  buildTargetBoundEvidenceEnvelope,
  digestVerificationContextPack,
} from '../core/authority-contracts.js';
import {
  createVerificationContextPack,
  createVerificationContextPackExpansion,
  parseGitDiffHunks,
} from '../core/verification-context-pack.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const root = mkdtempSync(join(tmpdir(), 'koala-vcp-'));
git(root, ['init']);
git(root, ['config', 'user.email', 'koala@example.test']);
git(root, ['config', 'user.name', 'Koala Smoke']);
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

const evidence = buildTargetBoundEvidenceEnvelope({
  evidenceId: 'EV-vcp',
  projectId: 'project',
  storyId: 'B-vcp',
  producerActorId: 'verifier-1',
  producerRunId: 'run-producer-1',
  verifierRunId: 'run-verifier-1',
  verificationContextPack: result.pack,
  command: 'npm test',
  exitCode: 0,
  nonce: 'nonce-vcp',
  createdAt: '2026-05-20T00:00:00Z',
});
assert.equal(evidence.verificationContextPackId, result.pack.packId);
assert.equal(evidence.verificationContextPackDigest, result.packDigest);
assert.deepEqual(evidence.inspectedPackRefs, allContextPackRequiredRefs(result.pack));

assert.ok(MAIN_TOOLS.some(tool => tool.name === 'verification_context_pack_create'));
assert.ok(MAIN_TOOLS.some(tool => tool.name === 'verification_context_pack_expand'));
assert.equal(isCommandAllowed('verification_context_pack_create', 'DEV'), true);
assert.equal(isCommandAllowed('verification_context_pack_expand', 'REVIEW'), true);

const handlers = createVerificationContextPackHandlers({ root } as any);
const handlerResult = handlers.verification_context_pack_create({
  producerRunId: 'run-producer-1',
  storyId: 'B-vcp',
});
assert.equal(handlerResult.packDigest, digestVerificationContextPack(handlerResult.pack));

console.log('verification context pack smoke passed');
