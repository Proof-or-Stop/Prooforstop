/** Exact historical/current runtime join. A baseReproduced label is never proof. */
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import { readHistoricalFindingRuntimeEvidence, readCurrentFindingRuntimeEvidence } from './finding-ledger.js';
import { canonicalHash } from '../core/finding-ledger.js';

export function readFindingBaseHeadPair(ctx: HandlerContext, storyId: string, ids: string[], baseHash: string, headHash: string) {
  if (ids.length !== 2 || ids[0] === ids[1]) throw new Error('dynamic finding: exact ordered base/head runtime pair required');
  const base = readHistoricalFindingRuntimeEvidence(ctx, storyId, ids[0]!);
  const head = readCurrentFindingRuntimeEvidence(ctx, storyId, ids[1]!);
  if (base.receipt.headHash !== baseHash || head.receipt.headHash !== headHash || baseHash === headHash
    || base.receipt.storyId !== storyId || head.receipt.storyId !== storyId
    || base.receipt.executionCommandDigest !== head.receipt.executionCommandDigest
    || base.receipt.buildCommandDigest !== head.receipt.buildCommandDigest
    || base.receipt.buildPolicyDigest !== head.receipt.buildPolicyDigest
    || canonicalHash(base.receipt.toolchain) !== canonicalHash(head.receipt.toolchain)
    || base.receipt.environment.contentDigest !== head.receipt.environment.contentDigest
    || Date.parse(base.receipt.completedAt) > Date.parse(head.receipt.startedAt)) {
    throw new Error('dynamic finding: base/head pair subject/command/environment/order mismatch');
  }
  execFileSync('git', ['merge-base', '--is-ancestor', baseHash, headHash], { cwd: ctx.root, stdio: 'pipe' });
  const parse = (stdout: string) => {
    const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('FINDING_WITNESS '));
    if (lines.length !== 1) throw new Error('dynamic finding: paired receipt witness missing');
    return JSON.parse(lines[0]!.slice('FINDING_WITNESS '.length));
  };
  const before = parse(base.stdout); const after = parse(head.stdout);
  if (before.storyId !== storyId || after.storyId !== storyId || before.findingId !== after.findingId
    || before.headHash !== baseHash || after.headHash !== headHash || after.baseHash !== baseHash
    || base.receipt.exitCode === 0 || base.receipt.exitCode !== head.receipt.exitCode
    || before.reproduced !== true || after.reproduced !== true
    || typeof before.failureFingerprint !== 'string' || !before.failureFingerprint.trim()
    || before.failureFingerprint !== after.failureFingerprint) throw new Error('dynamic finding: paired receipt does not reproduce the same defect');
  const a = before.impactVector; const b = after.impactVector;
  if (!a || !b || Array.isArray(a) || Array.isArray(b) || !Object.keys(a).length
    || canonicalHash(Object.keys(a).sort()) !== canonicalHash(Object.keys(b).sort())
    || Object.keys(a).some(key => typeof a[key] !== 'number' || !Number.isFinite(a[key]) || a[key] < 0
      || typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] < 0 || b[key] > a[key])) {
    throw new Error('dynamic finding: paired impact evidence missing or worsened');
  }
  return { base, head, before, after, digest: canonicalHash({ base: base.receipt.receiptHash, head: head.receipt.receiptHash }) };
}
