/** A merged SHA is provenance, not proof that a prerequisite passed. The
 * independent case PASS reviews these exact command/selector/receipt bindings. */
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import { applicabilityDigest } from '../core/finding-applicability.js';
import { FINDING_QUALIFICATION_POLICY } from '../core/finding-rollout-qualification.js';
import { findingWitnessCommandText } from './finding-applicability-proof.js';
import { readCurrentFindingRuntimeEvidence, readHistoricalFindingRuntimeEvidence } from './finding-ledger.js';

export interface QualificationPrerequisiteRef { name: string; mergedCommit: string; runtimeReceiptId: string; }
export function collectQualificationPrerequisites(ctx: HandlerContext, storyId: string, refs: QualificationPrerequisiteRef[], reportReceiptId: string) {
  if (!Array.isArray(refs)) throw new Error('qualification: prerequisite references must be an array');
  const pins = ctx.store.readChecklist(storyId).items.flatMap(item => Object.values(item.verificationIntent ?? {}).flatMap(rows =>
    Array.isArray(rows) ? rows.flatMap(row => row.verification ? [row.verification] : []) : []));
  const seen = new Set<string>();
  return Object.fromEntries(refs.map(ref => {
    if (!FINDING_QUALIFICATION_POLICY.requiredPrerequisites.includes(ref.name) || !/^[a-f0-9]{40,64}$/.test(ref.mergedCommit)
      || !ref.runtimeReceiptId || ref.runtimeReceiptId === reportReceiptId || seen.has(ref.name)) throw new Error('qualification: prerequisite invalid, missing receipt or duplicated');
    seen.add(ref.name);
    execFileSync('git', ['merge-base', '--is-ancestor', ref.mergedCommit, 'main'], { cwd: ctx.root, stdio: 'pipe' });
    // Admission is deliberately exact-current, not a claim that arbitrary old
    // passing tests remain valid after material, policy or environment changes.
    const runtime = readCurrentFindingRuntimeEvidence(ctx, storyId, ref.runtimeReceiptId);
    const selector = `FINDING_PREREQUISITE ${ref.name} ${ref.mergedCommit}`;
    const command = findingWitnessCommandText(runtime.executionCommand);
    if (runtime.receipt.headHash !== ref.mergedCommit || runtime.receipt.exitCode !== 0
      || !pins.some(pin => pin.command === command && pin.selector === selector)
      || runtime.stdout.split(/\r?\n/).filter(line => line === selector).length !== 1) throw new Error('qualification: prerequisite execution, subject or reviewed selector invalid');
    const proof = { ...ref, runtimeReceiptHash: runtime.receipt.receiptHash, command,
      executionCommandDigest: runtime.receipt.executionCommandDigest, selector };
    return [ref.name, { passed: true, evidenceDigests: [runtime.receipt.receiptHash, applicabilityDigest(proof)], proof }];
  }));
}
export type QualificationPrerequisites = ReturnType<typeof collectQualificationPrerequisites>;
/** Historical integrity only; no relabeling as fresh execution. Promotion also
 * requires the last case's exact current material and current prerequisite runs. */
export function verifyQualificationPrerequisites(ctx: HandlerContext, storyId: string, rows: QualificationPrerequisites) {
  for (const [name, row] of Object.entries(rows)) {
    const proof = row.proof;
    if (!proof || proof.name !== name || !FINDING_QUALIFICATION_POLICY.requiredPrerequisites.includes(name)) throw new Error('qualification: prerequisite proof missing');
    const runtime = readHistoricalFindingRuntimeEvidence(ctx, storyId, proof.runtimeReceiptId);
    if (!row.passed || runtime.receipt.receiptHash !== proof.runtimeReceiptHash || runtime.receipt.exitCode !== 0
      || runtime.receipt.headHash !== proof.mergedCommit || runtime.receipt.executionCommandDigest !== proof.executionCommandDigest
      || proof.selector !== `FINDING_PREREQUISITE ${name} ${proof.mergedCommit}`
      || runtime.stdout.split(/\r?\n/).filter(line => line === proof.selector).length !== 1
      || applicabilityDigest(row.evidenceDigests) !== applicabilityDigest([proof.runtimeReceiptHash, applicabilityDigest(proof)])) throw new Error('qualification: prerequisite historical proof substituted');
  }
}
