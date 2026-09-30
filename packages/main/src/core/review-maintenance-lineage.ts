import {reportHealthIssue} from './health.js';
import {isVerifiedEvidenceRefreshCommit, isOwnerLeaseHeartbeatOnly} from './review-evidence-refresh.js';
/** Narrow writer/consumer compatibility for authenticated review bookkeeping. */
import { execFileSync } from 'node:child_process';
import { observedGit } from './git-tree-observation.js';
import type { ObjectAddressedGitReader } from './git-object-read-memo.js';
import { REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES } from './runtime-fact-registry.js';
import { relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { StoryStore } from './store.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import { REVIEW_EPOCH_COMMIT_ARTIFACTS, isMissingReviewSnapshotError } from './review-metadata-surface.js';
import { isPromptBodyArtifactPath } from './prompt-body-store.js';
import { verifyReviewInventoryEpoch, verifyReviewInventoryReceipt } from './review-inventory-epoch.js';
import { digestCanonicalJson } from './digest.js';
import { CERTIFICATION_WINDOW_FILE, CERTIFICATION_WINDOW_FILE_SCHEMA, PRECERT_RECEIPT_SCHEMA, verifyCertificationWindow, verifyPrecertReceipt, verifyPrecertCheapCheckReceipt, isCertificationRunningOnlyAdvance, type CertificationWindowData } from './certification-window.js';
import { CLOSEOUT_WRITE_RECEIPTS_PATH, closeoutArtifactPolicyFor, verifyCloseoutWriteReceipt, type CloseoutWriteReceipt } from './closeout-trust.js';
import { evaluatePersistedReviewToTestIndexTransition } from './review-test-index-transition.js';
import type { ReviewInventoryEpochData, ReviewRun } from './types.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { currentFindingLedgerTrustFromWorkspace, validateEnvelope, verifyFindingLedgerReceipt, type LedgerEnvelope } from './finding-ledger.js';
import type { Finding, FindingLedgerReceipt, FindingLifecycleTransition } from './types.js';

const FINDING_RESOLVE_ARTIFACTS = new Set(['findings.json', 'finding-ledger.json', 'process-metrics.json', 'gate-failure-counts.json']);
const FINDING_RESOLVE_ROW_FIELDS = new Set(['status', 'resolvedAt', 'resolvedReason', 'resolutionType', 'resolveEvidenceStrength', 'recordId']);
const FINDING_RESOLVE_LEDGER_RECORDS = new Set(['legacy_identity_binding', 'finding_lifecycle_transition']);

/**
 * A finding_resolve metadata commit after the reviewed head is review
 * bookkeeping only when it is exactly: append-only signed ledger records
 * (identity binding + open->resolved transition), the findings.json mirror of
 * those transitions and nothing else, and optionally a subject-bound metrics
 * projection. Returns null when authentic, otherwise the refused rule.
 */
function findingResolvePublicationRefusal(args: {
  artifacts: string[]; storyId: string; metadataRoot: string;
  readAt: (name: string) => any; readPrior: (name: string) => any;
}): string | null {
  const { artifacts, storyId } = args;
  const foreign = artifacts.find(path => !FINDING_RESOLVE_ARTIFACTS.has(path));
  if (foreign) return `touches ${foreign}, outside findings.json/finding-ledger.json/process-metrics.json/gate-failure-counts.json`;
  if (!artifacts.includes('findings.json') || !artifacts.includes('finding-ledger.json')) return 'does not publish both findings.json and finding-ledger.json';
  if (artifacts.includes('process-metrics.json')) {
    const metrics = args.readAt('process-metrics.json');
    if (metrics.storyId !== storyId || typeof metrics.generatedAt !== 'string' || !metrics.sourceSnapshot || !metrics.dimensions) return 'process-metrics.json is not a subject-bound projection';
  }
  if (artifacts.includes('gate-failure-counts.json')) {
    // A tracked convergence-breaker counter swept in after a refused TEST probe; no review evidence.
    const counts = args.readAt('gate-failure-counts.json');
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)
      || Object.values(counts).some(row => !row || typeof row !== 'object' || Array.isArray(row))) return 'gate-failure-counts.json is not a gate counter map';
  }
  const ledger = args.readAt('finding-ledger.json') as LedgerEnvelope<unknown>;
  const priorLedger = args.readPrior('finding-ledger.json') as LedgerEnvelope<unknown> | undefined;
  try { validateEnvelope(ledger); } catch (error) { return `finding-ledger.json is invalid: ${error instanceof Error ? error.message : String(error)}`; }
  const priorRecords = priorLedger?.records ?? [];
  const priorReceipts = priorLedger?.receipts ?? [];
  if (digestCanonicalJson(ledger.records.slice(0, priorRecords.length)) !== digestCanonicalJson(priorRecords)
    || digestCanonicalJson(ledger.receipts.slice(0, priorReceipts.length)) !== digestCanonicalJson(priorReceipts)) return 'rewrites earlier finding-ledger records or receipts';
  const addedRecords = ledger.records.slice(priorRecords.length);
  const addedReceipts = ledger.receipts.slice(priorReceipts.length) as Array<(typeof ledger.receipts)[number] & { findingLedgerReceipt?: FindingLedgerReceipt }>;
  if (!addedRecords.length || addedRecords.some(record => !FINDING_RESOLVE_LEDGER_RECORDS.has(record.recordType))) return 'appends ledger records other than identity bindings and lifecycle transitions';
  const trust = currentFindingLedgerTrustFromWorkspace(args.metadataRoot);
  if (!trust) return 'finding ledger trust root is unavailable';
  const signedRecordIds = new Set<string>();
  for (const carrier of addedReceipts) {
    const signed = carrier.findingLedgerReceipt;
    if (!signed || !verifyFindingLedgerReceipt(signed, trust) || signed.storyId !== storyId || signed.receiptId !== carrier.receiptId
      || digestCanonicalJson(signed.recordIds) !== digestCanonicalJson(carrier.recordIds)) return `ledger receipt ${carrier.receiptId} is not a signed receipt of this Story`;
    for (const id of carrier.recordIds) signedRecordIds.add(id);
  }
  if (addedRecords.some(record => !signedRecordIds.has(record.recordId))) return 'appends a ledger record without its signed receipt';
  const transitions = addedRecords.filter(record => record.recordType === 'finding_lifecycle_transition')
    .map(record => record.payload as FindingLifecycleTransition);
  if (!transitions.length || transitions.some(t => t.fromStatus !== 'open' || t.toStatus !== 'resolved')) return 'lifecycle transitions are not open->resolved';
  const rows = (args.readAt('findings.json') as { findings?: Finding[] }).findings ?? [];
  const priorRows = (args.readPrior('findings.json') as { findings?: Finding[] } | undefined)?.findings ?? [];
  if (rows.length !== priorRows.length || rows.some((row, index) => row.id !== priorRows[index]!.id)) return 'findings.json adds, removes or reorders findings';
  const changed = rows.filter((row, index) => digestCanonicalJson(row) !== digestCanonicalJson(priorRows[index]));
  if (changed.length !== transitions.length || new Set(transitions.map(t => t.findingId)).size !== transitions.length) return 'findings.json changes do not match the lifecycle transitions one to one';
  for (const row of changed) {
    const before = priorRows[rows.indexOf(row)]! as unknown as Record<string, unknown>;
    const after = row as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const touched = [...keys].filter(key => digestCanonicalJson(before[key] ?? null) !== digestCanonicalJson(after[key] ?? null));
    const transition = transitions.find(t => t.findingId === row.id);
    if (!transition || before.status !== 'open' || row.status !== 'resolved'
      || touched.some(key => !FINDING_RESOLVE_ROW_FIELDS.has(key)) || (touched.includes('recordId') && before.recordId !== undefined)
      || row.recordId !== transition.findingRecordId || row.resolvedAt !== transition.at
      || (row.resolvedReason ?? undefined) !== (transition.reason ?? undefined)) return `findings.json row ${row.id} is not exactly the mirror of its signed resolve transition`;
  }
  return null;
}

export function isVerifiedReviewMaintenanceCommit(args: {
  gitCwd: string; metadataRoot: string; storyId: string; commit: string; reviewedHeadHash: string; reviewedMaterialHash?: string; reviewedStoryFilesHash?: string;
  /** The caller walk's object-addressed reader for gitCwd (git-object-read-memo). */
  objectRead?: ObjectAddressedGitReader;
  /** Diagnostic sink: the rule that refused this commit (never changes the verdict). */
  onRefusal?: (rule: string) => void;
}): boolean {
  const { gitCwd, metadataRoot, storyId, commit, reviewedHeadHash } = args;
  const no = (rule: string): false => { args.onRefusal?.(rule); return false; };
  // Read-only probes share the caller's synchronous git observation (one per
  // reviewer-evidence collection); outside one they always run git.
  // Reads addressed only by full object ids may come from the walk's process memo.
  const gitRaw = (argv: string[]) => {
    const run = () => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', maxBuffer: REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES, stdio: ['ignore','pipe','pipe'] });
    return args.objectRead ? args.objectRead(argv, run) : observedGit(gitCwd, argv, run);
  };
  const git = (argv: string[]) => gitRaw(argv).trim();
  try {
    const store = new StoryStore(metadataRoot);
    const prefix = relative(realpathSync(gitCwd), realpathSync(store.storyDirPath(storyId))).replaceAll('\\','/') + '/';
    if (prefix.startsWith('../') || prefix.startsWith('/') || prefix === './') return no('story directory is outside the Git workspace');
    const parents = git(['show','-s','--format=%P',commit]).split(/\s+/);
    if (parents.length !== 1 || !parents[0]) return no('not a single-parent commit');
    const subject = git(['show','-s','--format=%s',commit]);
    const paths = git(['diff-tree','--no-commit-id','--name-only','-r',commit]).split('\n').filter(Boolean);
    const outside = paths.find(p => !p.startsWith(prefix));
    if (!paths.length || outside) return no(outside ? `changes ${outside}, outside this Story's metadata directory` : 'empty commit');
    const artifacts = paths.map(p => p.slice(prefix.length));
    const readAt = (ref: string, name: string) => JSON.parse(git(['show',`${ref}:${prefix}${name}`]));
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} review epoch metadata`)) {
      if (!artifacts.includes('review-inventory-epochs.json')) return no('review epoch commit does not publish review-inventory-epochs.json');
      const foreign = artifacts.find(p => !(REVIEW_EPOCH_COMMIT_ARTIFACTS as readonly string[]).includes(p) && !isPromptBodyArtifactPath(p));
      if (foreign) return no(`review epoch commit touches ${foreign}, outside the review epoch publisher's artifacts`);
      const data = readAt(commit,'review-inventory-epochs.json') as ReviewInventoryEpochData;
      const epoch = data.epochs.at(-1);
      if (!epoch || epoch.storyId !== storyId || !verifyReviewInventoryEpoch(epoch)) return no('latest review inventory epoch is missing, foreign or signature-invalid');
      // finalize publishes a FINALIZED epoch; review_inventory_cancel (for
      // example of a completeness-only receipt that certification refuses)
      // publishes the same epoch CANCELLED. Both are the same batch publisher.
      const cancelled = epoch.state === 'CANCELLED';
      if (epoch.state !== 'FINALIZED' && !cancelled) return no(`latest epoch ${epoch.epochId} is ${epoch.state}, not a FINALIZED or CANCELLED publication`);
      if ((args.reviewedMaterialHash !== undefined && epoch.cutoff.materialHash !== args.reviewedMaterialHash)
        || (args.reviewedStoryFilesHash !== undefined && epoch.cutoff.storyFilesHash !== args.reviewedStoryFilesHash)) {
        return no(`epoch ${epoch.epochId} cutoff material/story-files differ from the reviewed material`);
      }
      if (epoch.cutoff.headHash !== reviewedHeadHash && (!args.reviewedMaterialHash || !args.reviewedStoryFilesHash)) return no(`epoch ${epoch.epochId} cutoff head differs from the reviewed head`);
      // An OPEN epoch freezes the cutoff before its reviewers; a direct
      // finalize freezes it after managed reviewer imports. Both are valid on
      // one ancestry chain. The outer live-binding reader separately verifies
      // each intervening importer commit. A sibling cutoff is never admitted.
      const isAncestor = (older: string, newer: string): boolean => {
        try { git(['merge-base','--is-ancestor',older,newer]); return true; }
        catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 1) return false;
          throw error;
        }
      };
      if (!isAncestor(reviewedHeadHash,parents[0])
        || !isAncestor(epoch.cutoff.headHash,parents[0])
        || (!isAncestor(epoch.cutoff.headHash,reviewedHeadHash)
          && !isAncestor(reviewedHeadHash,epoch.cutoff.headHash))) return no(`epoch ${epoch.epochId} cutoff and the reviewed head are not on one ancestry chain`);
      if (artifacts.includes('process-metrics.json')) {
        const metrics = readAt(commit,'process-metrics.json');
        if (metrics.storyId !== storyId || typeof metrics.generatedAt !== 'string' || !metrics.sourceSnapshot || !metrics.dimensions) return no('process-metrics.json is not a subject-bound projection');
      }
      // A copied signed epoch under a forged publisher subject is not a new publication.
      let previous: ReviewInventoryEpochData | undefined;
      try { git(['cat-file','-e',`${parents[0]}:${prefix}review-inventory-epochs.json`]);
        previous = readAt(parents[0],'review-inventory-epochs.json');
      } catch (error) {
        // Only a missing file is an initial publication; malformed existing data fails closed.
        try { git(['cat-file','-e',`${parents[0]}:${prefix}review-inventory-epochs.json`]); return no('previous review-inventory-epochs.json is unreadable'); } catch { /* absent */ }
      }
      const priorEpochs = previous?.epochs ?? [];
      const priorReceipts = previous?.receipts ?? [];
      const priorCritics = previous?.criticReceipts ?? [];
      // Critic receipts are append-only under both publications.
      if (digestCanonicalJson((data.criticReceipts ?? []).slice(0,priorCritics.length)) !== digestCanonicalJson(priorCritics)) return no('review epoch commit rewrites earlier critic receipts');
      let receipt: ReviewInventoryEpochData['receipts'][number] | undefined;
      if (cancelled) {
        // Exactly one prior live epoch changes, and only by its signed
        // cancellation; a FINALIZED target's receipt changes only by its
        // matching invalidation. Every other row stays byte-identical.
        const before = priorEpochs.find(row => row.epochId === epoch.epochId);
        if (!before || !verifyReviewInventoryEpoch(before) || before.consumedAt
          || (before.state !== 'OPEN' && before.state !== 'FINALIZED')) return no(`cancelled epoch ${epoch.epochId} was not a live OPEN or unconsumed FINALIZED epoch before this commit`);
        if (!epoch.cancelledAt || !epoch.cancelReason?.trim() || epoch.updatedAt !== epoch.cancelledAt) return no(`cancelled epoch ${epoch.epochId} has no signed cancellation`);
        const without = (row: object, fields: readonly string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
        const cancelFields = ['state', 'updatedAt', 'cancelledAt', 'cancelReason', 'terminalRunSequenceBoundary', '_hash'] as const;
        if (digestCanonicalJson(without(before, cancelFields)) !== digestCanonicalJson(without(epoch, cancelFields))) return no(`cancel of ${epoch.epochId} rewrites signed epoch fields beyond the cancellation`);
        if (data.epochs.length !== priorEpochs.length
          || digestCanonicalJson(data.epochs) !== digestCanonicalJson(priorEpochs.map(row => row.epochId === epoch.epochId ? epoch : row))) return no(`cancel of ${epoch.epochId} changes other epochs`);
        const expectedReceipts = priorReceipts.map(row => {
          if (before.state !== 'FINALIZED' || row.receiptId !== before.receiptId) return row;
          receipt = data.receipts.find(candidate => candidate.receiptId === row.receiptId);
          return receipt ?? row;
        });
        if (data.receipts.length !== priorReceipts.length || digestCanonicalJson(data.receipts) !== digestCanonicalJson(expectedReceipts)) return no(`cancel of ${epoch.epochId} changes unrelated inventory receipts`);
        if (before.state === 'FINALIZED') {
          const prior = priorReceipts.find(row => row.receiptId === before.receiptId);
          const invalidationFields = ['invalidatedAt', 'invalidationReason', '_hash'] as const;
          if (!prior || !receipt || !verifyReviewInventoryReceipt(prior) || prior.invalidatedAt || prior.consumedAt
            || !verifyReviewInventoryReceipt(receipt) || receipt.invalidatedAt !== epoch.cancelledAt
            || receipt.invalidationReason !== epoch.cancelReason
            || digestCanonicalJson(without(prior, invalidationFields)) !== digestCanonicalJson(without(receipt, invalidationFields))) return no(`cancel of ${epoch.epochId} does not carry exactly the signed invalidation of its receipt`);
        }
      } else {
        receipt = data.receipts.find(r => r.receiptId === epoch.receiptId);
        if (!receipt || !verifyReviewInventoryReceipt(receipt) || receipt.invalidatedAt
          || receipt.storyId !== storyId || receipt.epochId !== epoch.epochId
          || receipt.reviewRound !== epoch.reviewRound || receipt.scopeDigest !== epoch.scopeDigest
          || digestCanonicalJson(receipt.requiredLanes) !== digestCanonicalJson(epoch.requiredLanes) || digestCanonicalJson(receipt.cutoff) !== digestCanonicalJson(epoch.cutoff)) return no(`finalized epoch ${epoch.epochId} has no matching valid receipt`);
        if (previous?.epochs.some(e => e.epochId === epoch.epochId && e.state !== 'OPEN')) return no(`epoch ${epoch.epochId} was already terminal before this commit`);
        // Only the authenticated terminal target may be newly appended. Prefix
        // preservation alone must not admit unrelated unsigned history rows.
        const finalizedReceipt = receipt;
        if (data.epochs.length !== priorEpochs.length + (priorEpochs.some(row => row.epochId === epoch.epochId) ? 0 : 1)
          || data.receipts.length !== priorReceipts.length + (priorReceipts.some(row => row.receiptId === finalizedReceipt.receiptId) ? 0 : 1)) return no(`finalize of ${epoch.epochId} appends rows beyond its epoch and receipt`);
        if (previous && (digestCanonicalJson(data.epochs.slice(0,previous.epochs.length))
          !== digestCanonicalJson(previous.epochs.map(row => row.epochId === epoch.epochId ? epoch : row))
          || digestCanonicalJson(data.receipts.slice(0,previous.receipts.length)) !== digestCanonicalJson(previous.receipts))) return no(`finalize of ${epoch.epochId} rewrites earlier epochs or receipts`);
      }
      // Finalization may append independent review records; it cannot erase or
      // rewrite earlier observations under the batch publisher's subject.
      for (const [path,key] of [['review-runs.json','runs'],['review-passes.json','passes'],['findings.json','findings'],['prompt-envelopes.json','envelopes'],['finding-ledger.json','records'],['finding-ledger.json','receipts'],['convergence-progress.json','completedEpochBindings'],['convergence-progress.json','revokedCompletedEpochIds'],['convergence-progress.json','humanDecisions']]) {
        if (!artifacts.includes(path)) continue;
        const next = readAt(commit,path);
        const prior = git(['ls-tree','--name-only',parents[0],'--',prefix + path]) ? readAt(parents[0],path) : {[key]:[]};
        if (path === 'convergence-progress.json' && key === 'humanDecisions') { next[key] ??= []; prior[key] ??= []; }
        if (!Array.isArray(next[key]) || !Array.isArray(prior[key])
          || digestCanonicalJson(next[key].slice(0,prior[key].length)) !== digestCanonicalJson(prior[key])) return no(`review epoch commit rewrites earlier ${path} ${key}`);
        // Appended review evidence must be exactly this epoch's own deferred
        // results (the rows commitReviewResultMetadata deferred to this
        // publisher): a required lane of the epoch's round and cutoff, or its
        // bound inventory-completeness critic. Anything else is someone
        // else's evidence riding on the batch subject.
        if (path === 'review-passes.json' || path === 'findings.json') {
          const runs = (readAt(commit,'review-runs.json') as { runs?: ReviewRun[] }).runs ?? [];
          const required = new Set(epoch.requiredLanes.map(lane => canonicalAgentRoleId(lane)));
          for (const row of next[key].slice(prior[key].length) as Array<{ id?: string; reviewRunId?: string; reviewRound?: string; agent?: string }>) {
            const run = runs.find(candidate => candidate.reviewRunId === row.reviewRunId);
            const owned = !!run && run.storyId === storyId && run.reviewRound === epoch.reviewRound && row.reviewRound === epoch.reviewRound
              && run.materialHash === epoch.cutoff.materialHash && (run.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? '')
              && typeof row.agent === 'string' && canonicalAgentRoleId(row.agent) === canonicalAgentRoleId(run.lane)
              && (required.has(canonicalAgentRoleId(run.lane))
                || (run.reviewPurpose === 'inventory-completeness' && run.inventoryBinding?.epochId === epoch.epochId));
            if (!owned) return no(`review epoch commit appends ${path} row ${row.id ?? '?'} that is not a deferred result of epoch ${epoch.epochId}`);
          }
        }
      }
      const current = store.readReviewInventoryEpochs(storyId);
      const live = current.epochs.find(e => e.epochId === epoch.epochId);
      if (!live || !verifyReviewInventoryEpoch(live)) return no(`live epoch ${epoch.epochId} is missing or signature-invalid`);
      if (cancelled) return live._hash === epoch._hash || no(`live epoch ${epoch.epochId} differs from its published cancellation`);
      const liveReceipt = current.receipts.find(r => r.receiptId === receipt!.receiptId);
      // Later lifecycle outputs keep this publication authentic: certification
      // consumption (still FINALIZED) or a later signed cancellation (whose own
      // commit this walk verifies separately) that invalidated the receipt.
      const liveTerminal = live.state === 'FINALIZED'
        ? !!liveReceipt && !liveReceipt.invalidatedAt
        : live.state === 'CANCELLED' && !!liveReceipt && !!live.cancelledAt && liveReceipt.invalidatedAt === live.cancelledAt;
      return (liveTerminal && !!liveReceipt && verifyReviewInventoryReceipt(liveReceipt)
        && liveReceipt.epochId === epoch.epochId && liveReceipt.storyId === storyId
        && liveReceipt.reviewRound === epoch.reviewRound && digestCanonicalJson(liveReceipt.cutoff) === digestCanonicalJson(receipt!.cutoff)
        && live.receiptId === receipt!.receiptId && digestCanonicalJson(live.cutoff) === digestCanonicalJson(epoch.cutoff))
        || no(`live epoch ${epoch.epochId} (${live.state}) no longer matches its published receipt`);
    }
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} verification_evidence_add metadata`)) {
      return isVerifiedEvidenceRefreshCommit({...args,isProtectedArtifact:closeoutArtifactPolicyFor})
        || no('verification_evidence_add publication is not an authenticated evidence refresh');
    }
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} finding_resolve metadata`)) {
      // Closure rule (core/finding-closure.ts): the owner closes a verified
      // blocking finding in REVIEW. The publication touches no material and may
      // only carry signed open->resolved lifecycle transitions and their mirror.
      const refusal = findingResolvePublicationRefusal({ artifacts, storyId, metadataRoot,
        readAt: name => readAt(commit, name),
        readPrior: name => git(['ls-tree','--name-only',parents[0],'--',prefix + name]) ? readAt(parents[0], name) : undefined });
      return refusal === null || no(`finding_resolve publication: ${refusal}`);
    }
    // Official certification and validation publications retain code review only.
    // Their specialized gates still decide whether certification/validation passes.
    const writer = ['certification_window_begin', 'validate', 'test-transition'].find(command =>
      matchesRuntimeCommitSubject(subject, `record ${storyId} ${command} metadata`));
    if (!writer) return no(`subject "${subject}" is not an authenticated review-maintenance publisher`);
    // Bookkeeping never supplies a validation verdict here. Require parseable,
    // subject-bound projections; owner-lease changes retain only an unchanged owner and a heartbeat/PID update.
    // gate-failure-counts.json is the convergence breaker's repeated-gate
    // counter, bumped by every refused story_advance. It is a registry runtime
    // artifact, but a task repo that tracks it (runs 11 and 12) has it swept
    // into the next certification/validation publication; it carries no review
    // evidence and no validation verdict.
    const incidental = new Set(['process-events.jsonl', 'process-metrics.json', 'test-runs.json', 'owner-lease.json', 'gate-failure-counts.json']);
    if (artifacts.some(path => incidental.has(path) && closeoutArtifactPolicyFor(path))) return no(`${writer} publication: an incidental artifact is closeout-protected`);
    if (artifacts.includes('owner-lease.json') && (!git(['ls-tree','--name-only',parents[0],'--',prefix + 'owner-lease.json'])
      || !isOwnerLeaseHeartbeatOnly(readAt(parents[0],'owner-lease.json'),readAt(commit,'owner-lease.json')))) return no(`${writer} publication: owner-lease.json changes more than the heartbeat`);
    if (artifacts.includes('process-metrics.json')) {
      const metrics = readAt(commit,'process-metrics.json');
      if (metrics.storyId !== storyId || typeof metrics.generatedAt !== 'string' || !metrics.sourceSnapshot || !metrics.dimensions) return no(`${writer} publication: process-metrics.json is not a subject-bound projection`);
    }
    if (artifacts.includes('gate-failure-counts.json')) {
      const counts = readAt(commit,'gate-failure-counts.json');
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)
        || Object.values(counts).some(row => !row || typeof row !== 'object' || Array.isArray(row))) return no(`${writer} publication: gate-failure-counts.json is not a gate counter map`);
    }
    if (artifacts.includes('test-runs.json')) {
      const runs = readAt(commit,'test-runs.json').runs;
      if (!Array.isArray(runs) || runs.some(row => !row || typeof row.timestamp !== 'string' || typeof row.command !== 'string'
        || !['PASS','FAIL'].includes(row.result) || ['totalCases','passedCases','failedCases','durationMs'].some(key => !Number.isFinite(row[key]) || row[key] < 0)
        || row.totalCases !== row.passedCases + row.failedCases)) return no(`${writer} publication: test-runs.json rows are malformed`);
    }
    const substantive = artifacts.filter(path => !incidental.has(path) && path !== CLOSEOUT_WRITE_RECEIPTS_PATH);
    if (!substantive.length) return no(`${writer} publication: no substantive artifact`);
    const priorExists = (path: string) => Boolean(git(['ls-tree','--name-only',parents[0],'--',prefix + path]));
    const rawAt = (ref: string, path: string) => gitRaw(['show',`${ref}:${prefix}${path}`]);
    const readReceipts = (ref: string): CloseoutWriteReceipt[] => rawAt(ref,CLOSEOUT_WRITE_RECEIPTS_PATH).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const priorReceipts = priorExists(CLOSEOUT_WRITE_RECEIPTS_PATH) ? readReceipts(parents[0]) : [];
    const receipts = artifacts.includes(CLOSEOUT_WRITE_RECEIPTS_PATH) ? readReceipts(commit) : priorReceipts;
    if (digestCanonicalJson(receipts.slice(0,priorReceipts.length)) !== digestCanonicalJson(priorReceipts)) return no(`${writer} publication: closeout write receipts are rewritten`);
    const addedReceipts = receipts.slice(priorReceipts.length);
    const closeoutPaths = substantive.filter(path => closeoutArtifactPolicyFor(path)?.artifactClass === 'closeout-evidence');
    if (addedReceipts.length !== closeoutPaths.length) return no(`${writer} publication: closeout receipts do not match closeout artifacts`);
    for (const path of substantive) {
      if (path === CERTIFICATION_WINDOW_FILE) {
        if (writer === 'test-transition') return no(`${writer} publication: test-transition may not write certification-window.json`);
        const after = readAt(commit,path) as CertificationWindowData;
        const before: CertificationWindowData = priorExists(path) ? readAt(parents[0],path) as CertificationWindowData : {schemaVersion:CERTIFICATION_WINDOW_FILE_SCHEMA,windows:[],receipts:[]};
        if (after.schemaVersion !== CERTIFICATION_WINDOW_FILE_SCHEMA || !Array.isArray(after.windows) || !Array.isArray(after.receipts)) return no(`${writer} publication: certification-window.json schema`);
        if (after.windows.some(window => window.storyId !== storyId || !verifyCertificationWindow(window))) return no(`${writer} publication: a certification window is foreign or unsigned`);
        if (after.receipts.some(receipt => receipt.storyId !== storyId || !(receipt.schemaVersion === PRECERT_RECEIPT_SCHEMA ? verifyPrecertReceipt(receipt) : verifyPrecertCheapCheckReceipt(receipt)))) return no(`${writer} publication: a certification receipt is foreign or unsigned`);
        if (isCertificationRunningOnlyAdvance(before,after,storyId)) continue;
        // Admission and cheap checks append to existing history; they cannot
        // rewrite an earlier window or replace a prior receipt. The one
        // exception: a new begin first retires a drifted earlier live window
        // by its signed invalidation (a later REVIEW round, e.g. after a
        // TEST->DEV rework), changing nothing else in that row.
        const invalidationFields = ['state', 'updatedAt', 'blockerCode', 'blockerDetail', 'invalidation', '_hash'];
        const without = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => !invalidationFields.includes(key)));
        const earlierWindowKept = (prior: CertificationWindowData['windows'][number], next: CertificationWindowData['windows'][number] | undefined): boolean =>
          !!next && (digestCanonicalJson(next) === digestCanonicalJson(prior)
            || (writer === 'certification_window_begin' && next.state === 'INVALIDATED' && !!next.invalidation
              && (prior.state === 'ADMITTED' || prior.state === 'RUNNING')
              && digestCanonicalJson(without(next)) === digestCanonicalJson(without(prior))));
        if (after.windows.length < before.windows.length || before.windows.some((prior, index) => !earlierWindowKept(prior, after.windows[index]))
          || digestCanonicalJson(after.receipts.slice(0,before.receipts.length)) !== digestCanonicalJson(before.receipts)) return no(`${writer} publication: earlier certification windows/receipts are rewritten`);
        if (writer === 'certification_window_begin') {
          if (after.windows.length !== before.windows.length + 1) return no(`${writer} publication: begin must append exactly one window`);
          const window = after.windows.at(-1)!;
          if (window.state === 'BLOCKED') {
            // A refused begin publishes diagnostics, not admission. Preserve the
            // review lineage so its prescribed cheap-check retry can use the
            // same finalized inventory. Never accept heavy authority here.
            const diagnosticKeys = new Set(['schemaVersion', 'windowId', 'storyId', 'state',
              'createdAt', 'updatedAt', 'blockerCode', 'blockerDetail', 'inventory', '_hash']);
            if (Object.keys(window).some(key => !diagnosticKeys.has(key))
              || !window.blockerCode?.trim() || !window.blockerDetail?.trim()
              || after.receipts.slice(before.receipts.length).some(row => row.schemaVersion === PRECERT_RECEIPT_SCHEMA)
              || substantive.some(path => path !== CERTIFICATION_WINDOW_FILE)) return no(`${writer} publication: refused begin carries more than diagnostics`);
            continue;
          }
          if (window.state !== 'ADMITTED') return no(`${writer} publication: begin window is neither ADMITTED nor BLOCKED`);
          const receipt = after.receipts.find(row => row.receiptId === window.receiptId);
          if (!receipt || receipt.schemaVersion !== PRECERT_RECEIPT_SCHEMA || receipt.windowId !== window.windowId
            || digestCanonicalJson(receipt.frozen) !== digestCanonicalJson(window.frozen)) return no(`${writer} publication: admitted window has no matching PRE_CERT receipt`);
        } else if (after.windows.length !== before.windows.length || after.receipts.length <= before.receipts.length
          || after.receipts.slice(before.receipts.length).some(row => row.schemaVersion === PRECERT_RECEIPT_SCHEMA)) return no(`${writer} publication: validate may only append cheap-check receipts`);
        continue;
      }
      if (path === 'review-inventory-epochs.json') {
        if (writer !== 'certification_window_begin' || !artifacts.includes(CERTIFICATION_WINDOW_FILE)) return no(`${writer} publication: review-inventory-epochs.json change outside an admitted certification begin`);
        const before = readAt(parents[0],path) as ReviewInventoryEpochData;
        const after = readAt(commit,path) as ReviewInventoryEpochData;
        const window = (readAt(commit,CERTIFICATION_WINDOW_FILE) as CertificationWindowData).windows.at(-1);
        if (!window || window.state !== 'ADMITTED' || !verifyCertificationWindow(window)) return no(`${writer} publication: consumed epoch window is not ADMITTED`);
        const epoch = after.epochs.find(row => row.epochId === window.inventory?.epochId);
        const receipt = after.receipts.find(row => row.receiptId === window.inventory?.receiptId);
        const oldEpoch = before.epochs.find(row => row.epochId === epoch?.epochId);
        const oldReceipt = before.receipts.find(row => row.receiptId === receipt?.receiptId);
        if (!epoch || !receipt || !oldEpoch || !oldReceipt || oldEpoch.consumedAt || oldReceipt.consumedAt
          || !verifyReviewInventoryEpoch(epoch) || !verifyReviewInventoryReceipt(receipt)
          || epoch.storyId !== storyId || receipt.storyId !== storyId || epoch.state !== 'FINALIZED' || receipt.invalidatedAt
          || !epoch.consumedAt || epoch.consumedAt !== receipt.consumedAt
          || epoch.consumedByCertificationWindowId !== window.windowId || receipt.consumedByCertificationWindowId !== window.windowId
          || epoch.consumedByReviewRound !== epoch.reviewRound) return no(`${writer} publication: inventory consumption is not exactly the admitted window's`);
        const expected = {...before,
          epochs:before.epochs.map(row => row.epochId === epoch.epochId ? {...row,consumedAt:epoch.consumedAt,consumedByCertificationWindowId:window.windowId,consumedByReviewRound:row.reviewRound,updatedAt:epoch.consumedAt,_hash:epoch._hash} : row),
          receipts:before.receipts.map(row => row.receiptId === receipt.receiptId ? {...row,consumedAt:epoch.consumedAt,consumedByCertificationWindowId:window.windowId,_hash:receipt._hash} : row)};
        if (digestCanonicalJson(after) !== digestCanonicalJson(expected)) return no(`${writer} publication: inventory consumption rewrites more than consumption fields`);
        continue;
      }
      if (path === 'index.json') {
        if (writer !== 'test-transition') return no(`${writer} publication: index.json change outside the TEST transition`);
        const after = readAt(commit,path);
        if (!evaluatePersistedReviewToTestIndexTransition(gitCwd,prefix + path,
          {headHash:parents[0],storyId,reviewRound:readAt(reviewedHeadHash,'index.json').currentReviewRound},after).ok) return no(`${writer} publication: index.json change is not the persisted REVIEW->TEST transition`);
        continue;
      }
      if (writer !== 'validate' || !closeoutPaths.includes(path)) return no(`${writer} publication: changes a non-closeout artifact ${path}`);
      const matching = addedReceipts.filter(receipt => receipt.artifactPath === path);
      const receipt = matching[0];
      if (matching.length !== 1 || receipt.writerCommand !== writer || receipt.headHash !== parents[0]
        || !verifyCloseoutWriteReceipt(receipt,{storyId,artifactPath:path,artifactBytes:rawAt(commit,path),projectRoot:gitCwd,metadataRoot}).ok) return no(`${writer} publication: closeout receipt does not verify`);
      const prior = priorReceipts.filter(row => row.artifactPath === path).at(-1);
      if (receipt.sequence !== (prior?.sequence ?? 0) + 1 || receipt.previousIntegrityHash !== (prior?.integrityHash ?? null)) return no(`${writer} publication: closeout receipt sequence is broken`);
    }
    return true;
  } catch (error) {
    if (!isMissingReviewSnapshotError(error))
      reportHealthIssue('review-maintenance-lineage',error instanceof Error ? error : {message:String(error)},{storyId});
    return no(`unreadable publication: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}
