import { assertCanonicalActiveIdentityBoundary } from './runtime-environment-checks.js';
import { ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA, ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA } from './artifact-schema.js';
import { prepareManagedSingletonAdmission, bindManagedSingletonSubmission } from './managed-launch-admission.js';
import { resolveManagedReviewIsolation } from './managed-review-lane-policy.js';
/** Acceptance owns proposal derivation and recoverable application; reviewers own only their verdict. */
import { createHash } from 'node:crypto';
import { storyScopeBudgetBlocker } from './story-scope-budget.js';
import { projectPromptAsset } from './prompt-registry.js';
import { realpathSync } from 'node:fs';
import type { StoryStore } from './store.js';
import { deriveAcceptanceAmendment, type AcceptanceAmendmentSnapshot, type AcceptanceAmendmentDelta } from './acceptance-amendment.js';
import { ACCEPTANCE_REVIEW_LANE, ACCEPTANCE_REVIEW_PROFILE } from './acceptance-amendment-review.js';
import { canonicalDigest } from './authority-signing.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, captureEvidenceHashSnapshot } from './evidence-freshness.js';
import { withReviewInventoryMutationLock } from './review-inventory-epoch.js';
import { submitManagedHostRun, readManagedAcceptanceReviewReceipt, type ManagedHostRunSubmitDeps, type ManagedHostRunSubmitArgs } from './managed-host-run.js';

export interface AcceptanceAmendmentEntry {
  schemaVersion: typeof ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA;
  storyId: string;
  amendmentId: string;
  submitterSessionId: string;
  state: 'PROPOSED' | 'REVIEWING' | 'APPLYING' | 'APPROVED' | 'CANCELLED';
  base: AcceptanceAmendmentSnapshot;
  delta: AcceptanceAmendmentDelta;
  baseDigest: string;
  amendmentDigest: string;
  nextDigest: string;
  requestDigest: string;
  review?: { runId: string; publicKey: string; promptDigest: string; headHash: string; materialHash: string; storyFilesHash: string; receiptId?: string };
  cancellationReason?: string;
  signature: string;
}
export interface AcceptanceAmendmentJournal {
  schemaVersion: typeof ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA;
  entries: AcceptanceAmendmentEntry[];
  signature?: string;
}
const hashText = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const pending = (entry: AcceptanceAmendmentEntry) => !['APPROVED', 'CANCELLED'].includes(entry.state);

function readJournal(store: StoryStore, storyId: string, root: string): AcceptanceAmendmentJournal {
  assertCanonicalActiveIdentityBoundary({ boundaryId: 'canonical-journal-authority' });
  const journal = store.readAcceptanceAmendments(storyId);
  if (!journal) return { schemaVersion: ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA, entries: [] };
  if (journal.schemaVersion !== ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA || !Array.isArray(journal.entries)
    || new Set(journal.entries.map(e => e.amendmentId)).size !== journal.entries.length) throw new Error('acceptance amendment journal invalid');
  const { signature: journalSignature, ...journalClaims } = journal;
  if (!verifyValidationArtifact(journalClaims, journalSignature, root)) throw new Error('acceptance amendment journal signature invalid');
  for (const entry of journal.entries) {
    const { signature, ...claims } = entry;
    if (entry.storyId !== storyId || entry.schemaVersion !== ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA
      || !verifyValidationArtifact(claims, signature, root)) throw new Error('acceptance amendment signature invalid');
  }
  return journal;
}
export { readJournal as readAuthenticatedAcceptanceAmendmentJournal };
function snapshot(store: StoryStore, storyId: string): AcceptanceAmendmentSnapshot {
  const scope = store.readScopeContract(storyId), proofStory = store.readProofStoryContract(storyId);
  if (!scope || !proofStory) {
    const missing = [
      ...(!scope ? [
        `scope-contract.json (run: proof-or-stop scope_contract_init_from_plan --storyId=${storyId})`,
      ] : []),
      ...(!proofStory ? [
        `proofstory-contract.json (run: proof-or-stop proofstory_contract_set --storyId=${storyId} with the planned acceptance bindings)`,
      ] : []),
    ];
    throw new Error(`acceptance amendment prerequisites missing for ${storyId}: ${missing.join('; ')}`);
  }
  return { storyId, checklist: store.readChecklist(storyId), scope, proofStory };
}

export function acceptanceAmendmentBlocker(store: StoryStore, storyId: string, root: string): string | null {
  try {
    const entries = readJournal(store, storyId, root).entries.filter(pending);
    return entries.length ? `Acceptance amendment pending: ${entries.map(e => `${e.amendmentId} ${e.state}`).join(', ')}` : null;
  } catch (error) { return `Acceptance amendment invalid: ${error instanceof Error ? error.message : String(error)}`; }
}

export function createAcceptanceAmendmentController(store: StoryStore, root: string) {
  const locked = <T>(storyId: string, action: () => T) => withReviewInventoryMutationLock(store, storyId, action);
  const requireDev = (storyId: string) => {
    if (store.readStory(storyId).phase !== 'DEV') throw new Error('AcceptanceAmendment requires DEV; return from REVIEW before proposing requirements');
  };
  const save = (journal: AcceptanceAmendmentJournal, entry: AcceptanceAmendmentEntry) => {
    const { signature: _old, ...claims } = entry;
    const signed = { ...claims, signature: signValidationArtifact(claims, root) };
    const index = journal.entries.findIndex(e => e.amendmentId === signed.amendmentId);
    if (index < 0) journal.entries.push(signed); else journal.entries[index] = signed;
    const { signature: _journalSignature, ...journalClaims } = journal;
    store.writeAcceptanceAmendments(entry.storyId, { ...journalClaims, signature: signValidationArtifact(journalClaims, root) });
    return signed;
  };
  const entryFor = (storyId: string, amendmentId: string) => {
    const journal = readJournal(store, storyId, root);
    const entry = journal.entries.find(e => e.amendmentId === amendmentId);
    if (!entry) throw new Error('Acceptance amendment not found');
    return { journal, entry };
  };
  const assertBase = (entry: AcceptanceAmendmentEntry) => {
    if (canonicalDigest(snapshot(store, entry.storyId)) !== entry.baseDigest) throw new Error('Acceptance amendment base drift; cancel and propose against current acceptance');
  };
  const consume = (entry: AcceptanceAmendmentEntry) => {
    if (!entry.review) throw new Error('Acceptance amendment requires independent review receipt');
    const verified = readManagedAcceptanceReviewReceipt(root, entry.review.runId, {
      amendmentId: entry.amendmentId, amendmentDigest: entry.amendmentDigest, baseDigest: entry.baseDigest,
      submitterSessionId: entry.submitterSessionId, storyId: entry.storyId, promptDigest: entry.review.promptDigest, publicKey: entry.review.publicKey,
    });
    if (verified.proposal.decision !== 'approve') throw new Error('Acceptance amendment reviewer rejected proposal');
    return verified;
  };
  return {
    show(storyId: string) { return readJournal(store, storyId, root); },
    propose(args: { storyId: string; amendmentId: string; delta: AcceptanceAmendmentDelta; submitterSessionId: string }, onCreated?: () => void) {
      return locked(args.storyId, () => {
        requireDev(args.storyId);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(args.amendmentId) || !args.submitterSessionId?.trim()) throw new Error('Acceptance amendment requires stable ID and submitter identity');
        const journal = readJournal(store, args.storyId, root), requestDigest = canonicalDigest(args);
        const prior = journal.entries.find(e => e.amendmentId === args.amendmentId);
        if (prior) {
          if (prior.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_CONFLICT: amendment input changed');
          return prior;
        }
        if (journal.entries.some(pending)) throw new Error('Another acceptance amendment is pending; finish or cancel it first');
        const base = snapshot(store, args.storyId), next = deriveAcceptanceAmendment(base, args.delta);
        const baseDigest = canonicalDigest(base);
        const proposed = save(journal, { schemaVersion: ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA, ...args, state: 'PROPOSED', base,
          baseDigest, amendmentDigest: canonicalDigest({ storyId: args.storyId, baseDigest, delta: args.delta }), nextDigest: canonicalDigest(next), requestDigest, signature: '' });
        onCreated?.(); // The owner's optional metadata commit remains inside the same serialization boundary.
        return proposed;
      });
    },
    async startReview(args: { storyId: string; amendmentId: string; host: 'codex' | 'claude' }, deps: ManagedHostRunSubmitDeps = {}) {
      const prepared = locked(args.storyId, () => {
        requireDev(args.storyId);
        const { entry } = entryFor(args.storyId, args.amendmentId);
        if (entry.state === 'REVIEWING' && entry.review) return { existing: entry.review.runId };
        if (entry.state !== 'PROPOSED') throw new Error('Acceptance amendment is not awaiting review');
        assertBase(entry);
        if (captureEvidenceHashSnapshot({ gitCwd: root }).materialDirtyFiles.length) throw new Error('Acceptance review source drift: commit reviewed source first');
        const headHash = currentGitHead(root), materialHash = currentMaterialHash(root), storyFilesHash = currentStoryFilesHash(root);
        if (!headHash || !materialHash || !storyFilesHash) throw new Error('Acceptance reviewer requires current Git/material/Story-file identities');
        const binding = { amendmentId: entry.amendmentId, amendmentDigest: entry.amendmentDigest, baseDigest: entry.baseDigest, submitterSessionId: entry.submitterSessionId };
        const promptText = projectPromptAsset({kind:'acceptance-review', subject:{storyId:args.storyId,
          binding, originalAcceptance:entry.base, additiveDelta:entry.delta}}, args.host).hostBody;
        return { entry, binding, promptText, headHash, materialHash, storyFilesHash };
      });
      if ('existing' in prepared) return { runId: prepared.existing!, recoveryHint: 'Inspect this exact run with host_run_status. For a terminal failure, rejection or stale source, cancel the amendment with a reason and propose a new amendment ID; never replace its pinned key.' };
      const submitArgs: ManagedHostRunSubmitArgs = { root, cwd: root, host: args.host, storyId: args.storyId, phase: 'DEV',
        agentType: ACCEPTANCE_REVIEW_LANE, lane: ACCEPTANCE_REVIEW_LANE, reviewRunId: `${args.storyId}:AMR-${args.amendmentId}`,
        profile: ACCEPTANCE_REVIEW_PROFILE, acceptanceReviewBinding: prepared.binding, isolateManagedReview: true,
        promptText: prepared.promptText, projectRootHash: hashText(realpathSync(root)),
        reviewBinding: { headHash: prepared.headHash, materialHash: prepared.materialHash, storyFilesHash: prepared.storyFilesHash,
          promptHash: hashText(prepared.promptText), managedPromptDigest: hashText(prepared.promptText), envelopeId: null },
      };
      if (resolveManagedReviewIsolation(root)) {
        const deriveSubjectIdentity = () => locked(args.storyId, () => {
          requireDev(args.storyId);
          const { entry } = entryFor(args.storyId, args.amendmentId);
          if (entry.state !== 'PROPOSED') throw new Error('Acceptance admission subject is no longer proposed');
          assertBase(entry);
          if (captureEvidenceHashSnapshot({ gitCwd: root }).materialDirtyFiles.length) throw new Error('Acceptance admission material drift');
          return canonicalDigest({schema:'acceptance-execution-subject.v1',root:realpathSync(root),storyId:args.storyId,
            amendmentId:entry.amendmentId,amendmentDigest:entry.amendmentDigest,baseDigest:entry.baseDigest,
            headHash:currentGitHead(root),materialHash:currentMaterialHash(root),storyFilesHash:currentStoryFilesHash(root)});
        });
        const token = await prepareManagedSingletonAdmission({root,storyId:args.storyId,profile:ACCEPTANCE_REVIEW_PROFILE,
          lane:ACCEPTANCE_REVIEW_LANE,host:args.host,subjectIdentity:deriveSubjectIdentity(),deriveSubjectIdentity,
          effectiveBaseEnvironment:{...process.env}});
        bindManagedSingletonSubmission(submitArgs,token);
      }
      return submitManagedHostRun(submitArgs, { ...deps, onAcceptanceReviewKeyCreated: ({ runId, publicKey }) => locked(args.storyId, () => {
        requireDev(args.storyId);
        const { journal, entry } = entryFor(args.storyId, args.amendmentId);
        if (entry.state !== 'PROPOSED') throw new Error('Acceptance review attempt changed before key pin');
        assertBase(entry);
        save(journal, { ...entry, state: 'REVIEWING', review: { runId, publicKey, promptDigest: hashText(prepared.promptText),
          headHash: prepared.headHash, materialHash: prepared.materialHash, storyFilesHash: prepared.storyFilesHash } });
      }) });
    },
    approve(args: { storyId: string; amendmentId: string }, onChanged?: () => void) {
      return locked(args.storyId, () => {
        requireDev(args.storyId);
        let { journal, entry } = entryFor(args.storyId, args.amendmentId);
        const verified = consume(entry);
        if (entry.state === 'APPROVED') return entry;
        if (!['REVIEWING', 'APPLYING'].includes(entry.state)) throw new Error('Acceptance amendment is not approved for application');
        const next = deriveAcceptanceAmendment(entry.base, entry.delta);
        if (canonicalDigest(next) !== entry.nextDigest) throw new Error('Acceptance amendment derivation drift');
        const budgetBlocker = storyScopeBudgetBlocker(store, root, args.storyId, next, entry.base);
        if (budgetBlocker) throw new Error(budgetBlocker);
        const assertReviewedSource = () => {
          if (captureEvidenceHashSnapshot({ gitCwd: root }).materialDirtyFiles.length) throw new Error('Acceptance review source drift: uncommitted material changed');
          if (currentGitHead(root) !== entry.review!.headHash || currentMaterialHash(root) !== entry.review!.materialHash
            || currentStoryFilesHash(root) !== entry.review!.storyFilesHash) throw new Error('Acceptance review source drift; restore reviewed source for APPLYING recovery, otherwise cancel and propose anew');
        };
        assertReviewedSource();
        if (entry.state !== 'APPLYING') {
          assertBase(entry);
          entry = save(journal, { ...entry, state: 'APPLYING', review: { ...entry.review!, receiptId: verified.receipt.receiptId } });
        }
        const current = snapshot(store, args.storyId);
        for (const key of ['checklist', 'scope', 'proofStory'] as const) {
          const digest = canonicalDigest(current[key]);
          if (digest !== canonicalDigest(entry.base[key]) && digest !== canonicalDigest(next[key])) throw new Error(`Acceptance amendment interrupted ${key} drift; refuse overwrite`);
        }
        // The signed APPLYING marker blocks every completion consumer until all three exact writes finish.
        if (canonicalDigest(current.checklist) !== canonicalDigest(next.checklist)) store.writeChecklist(args.storyId, next.checklist);
        store.writeScopeContract(args.storyId, next.scope);
        store.writeProofStoryContract(args.storyId, next.proofStory);
        if (canonicalDigest(snapshot(store, args.storyId)) !== entry.nextDigest) throw new Error('Acceptance amendment application incomplete');
        assertReviewedSource();
        const applied = save(journal, { ...entry, state: 'APPROVED' });
        onChanged?.();
        return applied;
      });
    },
    cancel(args: { storyId: string; amendmentId: string; reason: string }, onChanged?: () => void) {
      return locked(args.storyId, () => {
        requireDev(args.storyId);
        const { journal, entry } = entryFor(args.storyId, args.amendmentId);
        if (!args.reason?.trim() || ['APPLYING', 'APPROVED'].includes(entry.state)) throw new Error('Cannot cancel an applying or approved amendment; recover its application');
        if (entry.state === 'CANCELLED') return entry;
        const cancelled = save(journal, { ...entry, state: 'CANCELLED', cancellationReason: args.reason });
        onChanged?.();
        return cancelled;
      });
    },
  };
}
