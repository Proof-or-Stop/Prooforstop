import { computeCanonicalDigest as digest } from './evidence/artifact-store.js';
import { currentMaterialHash, currentStoryFilesHash, checkEvidenceFreshnessForGit } from './evidence-freshness.js';
import { collectVerificationIntents, isExecutableIntentType } from './verification.js';
import { evaluateVerificationEvidenceForGate } from './proof-admissibility.js';
import { isReusableVerificationReceipt, prepareVerificationExecutionIdentity, withVerificationRefreshObservation } from './verification-execution-evidence.js';
import type { ChecklistData, VerificationEvidence } from './types.js';

export type IntentFingerprintAction = 'missing' | 'current' | 'reuse' | 'rerun' | 'invalid' | 'manual';
export interface IntentFingerprintRow {
  intentKey: string;
  intentRef: string;
  itemId: string;
  lane: string;
  description: string;
  executable: boolean;
  command: string | null;
  executionKey: string | null;
  currentFingerprint: string;
  executionFingerprint: string | null;
  recordedExecutionFingerprint: string | null;
  inputClosure: 'complete' | 'incomplete' | 'unavailable' | 'not-executable';
  action: IntentFingerprintAction;
  reason: string;
  changed: boolean | null;
  inputFiles: Array<{ path: string; digest: string }>;
}
export interface IntentFingerprintReport {
  schemaVersion: 'proof-or-stop.intent-fingerprint-report.v1';
  authority: 'diagnostic-only';
  storyId: string;
  rootFingerprint: string;
  intents: IntentFingerprintRow[];
  executions: Array<{ executionKey: string; command: string; intentRefs: string[]; intentKeys: string[]; requiresExecution: boolean }>;
}

export function intentFingerprintKey(itemId: string, intentRef: string): string {
  return JSON.stringify([itemId, intentRef]);
}

/** Match the writer's item ownership; a foreign item's record is never borrowed. */
export function selectItemIntentEvidence(item: ChecklistData['items'][number], ref: string): VerificationEvidence | undefined {
  const candidates = (item.verificationEvidence ?? []).filter(e => e.intentRef === ref);
  return candidates.find(e => e.result === 'pass') ?? candidates[0];
}

/** Derived index, never proof authority. Gate validation still authenticates every row. */
export function buildIntentFingerprintReport(input: {
  projectRoot: string;
  gitCwd: string;
  storyId: string;
  checklist: ChecklistData;
}): IntentFingerprintReport {
  return withVerificationRefreshObservation(() => {
    const materialHash = currentMaterialHash(input.gitCwd, 'HEAD', input.projectRoot);
    const storyFilesHash = currentStoryFilesHash(input.gitCwd, 'HEAD', input.projectRoot);
    const intents: IntentFingerprintRow[] = [];
    const ids = new Set<string>();
    const identities = new Map<string, ReturnType<typeof prepareVerificationExecutionIdentity>>();
    for (const item of input.checklist.items) {
      for (const collected of collectVerificationIntents(item)) {
        const { ref, intent, lane } = collected;
        const intentKey = intentFingerprintKey(item.id, ref);
        if (ids.has(intentKey)) throw new Error(`Duplicate verification intent identity: ${item.id}/${ref}`);
        ids.add(intentKey);
        const evidence = selectItemIntentEvidence(item, ref);
        const pin = intent.verification;
        const command = pin?.command ?? evidence?.command ?? null;
        const executable = isExecutableIntentType(intent.type) || Boolean(pin);
        const row: IntentFingerprintRow = {
          intentKey, intentRef: ref, itemId: item.id, lane, description: intent.desc, executable, command,
          executionKey: null, currentFingerprint: '', executionFingerprint: null, recordedExecutionFingerprint: null,
          inputClosure: executable ? 'unavailable' : 'not-executable', action: evidence ? 'manual' : 'missing',
          reason: evidence ? 'non-executable attestation uses its existing policy' : 'no evidence recorded', changed: null, inputFiles: [],
        };
        if (evidence?.kind === 'waiver') {
          row.reason = 'waiver uses its existing coverage policy; it does not authorize execution reuse';
        } else if (executable && evidence) {
          if (!pin) {
            row.action = 'invalid'; row.reason = 'missing immutable verification command/selector pin';
          } else {
            // This authenticates signatures, command/selector links and full output before reuse claims.
            const admission = evaluateVerificationEvidenceForGate({ projectRoot: input.projectRoot, storyId: input.storyId, intentRef: ref, command: pin.command, selector: pin.selector, evidence });
            row.action = admission.allowed ? evidence.result === 'pass' ? 'current' : 'rerun' : admission.state === 'invalid' ? 'invalid' : 'rerun';
            row.reason = evidence.result === 'pass' ? admission.detail : `recorded result is ${evidence.result ?? 'missing'}; ${admission.detail}`;
            if (isReusableVerificationReceipt(evidence.receipt) && row.action !== 'invalid') {
              const execution = evidence.receipt.executionReceipt;
              const identityArgs = { command: pin.command, cwd: execution.cwd, effectiveTimeoutMs: execution.effectiveTimeoutMs, manifestPath: execution.dependencyManifest?.path };
              const key = digest(identityArgs);
              try {
                let identity = identities.get(key);
                if (!identity) { identity = prepareVerificationExecutionIdentity(identityArgs); identities.set(key, identity); }
                row.executionKey = key;
                row.inputClosure = identity.reusable ? 'complete' : 'incomplete';
                row.inputFiles = identity.dependency.inputFiles;
                // Unknown dependencies keep strict whole-material binding; never infer completeness from path disjointness.
                row.executionFingerprint = digest({ identity: identity.executionIdentityDigest, ...(identity.reusable ? {} : { materialHash: materialHash ?? null, storyFilesHash: storyFilesHash ?? null }) });
                row.recordedExecutionFingerprint = digest({ identity: execution.executionIdentityDigest, ...(identity.reusable && execution.inputClosureComplete ? {} : { materialHash: evidence.materialHash ?? null, storyFilesHash: evidence.storyFilesHash ?? null }) });
                row.changed = row.executionFingerprint !== row.recordedExecutionFingerprint;
                if (identity.reason) row.reason += `; ${identity.reason}`;
                if (admission.allowed && evidence.result === 'pass' && identity.reusable) {
                  const freshness = checkEvidenceFreshnessForGit(input.gitCwd, evidence.headHash, evidence.materialHash, input.projectRoot, evidence.storyFilesHash);
                  // Reuse is advice for the existing signed writer, never a newly issued receipt.
                  if (!freshness.fresh || evidence.materialHash !== materialHash || evidence.storyFilesHash !== storyFilesHash) row.action = 'reuse';
                }
              } catch (error) {
                // PROBE: an unresolvable execution identity cannot authorize reuse.
                row.action = 'rerun'; row.reason = `execution inputs unavailable: ${error instanceof Error ? error.message : String(error)}`;
              }
            }
          }
        }
        if (executable && command && !row.executionKey) row.executionKey = digest({ command, cwd: input.gitCwd, unresolvedExecution: true });
        const { verification, ...semantics } = intent;
        row.currentFingerprint = digest({
          schemaVersion: 'proof-or-stop.intent-input-fingerprint.v1', storyId: input.storyId,
          itemId: item.id, intentRef: ref, lane, semantics,
          pin: verification ? { command: verification.command, selector: verification.selector } : null,
          execution: row.executionFingerprint,
        });
        intents.push(row);
      }
    }
    intents.sort((a, b) => a.intentKey < b.intentKey ? -1 : a.intentKey > b.intentKey ? 1 : 0);
    const groups = new Map<string, IntentFingerprintReport['executions'][number]>();
    for (const row of intents) {
      if (!row.executionKey || !row.command) continue;
      let group = groups.get(row.executionKey);
      if (!group) { group = { executionKey: row.executionKey, command: row.command, intentRefs: [], intentKeys: [], requiresExecution: false }; groups.set(row.executionKey, group); }
      group.intentRefs.push(row.intentRef);
      group.intentKeys.push(row.intentKey);
      group.requiresExecution ||= row.action !== 'current' && row.action !== 'reuse' && row.action !== 'manual';
    }
    return {
      schemaVersion: 'proof-or-stop.intent-fingerprint-report.v1', authority: 'diagnostic-only', storyId: input.storyId,
      rootFingerprint: digest({ storyId: input.storyId, intents: intents.map(row => ({ intentKey: row.intentKey, fingerprint: row.currentFingerprint })) }),
      intents, executions: [...groups.values()].sort((a, b) => a.executionKey.localeCompare(b.executionKey)),
    };
  });
}
