# Managed review after inventory finalization

B-0980 exposed a protocol mismatch: the inventory finalizer batches signed
review artifacts into a canonical epoch commit, while managed review consumption
accepted only individual importer commits. Refreshing authentic verification
receipts introduced another official metadata commit that readers rejected.
The inventory critic consumer also eagerly rebuilt an OPEN-only provider prompt
after its epoch had already finalized.

Review and certification now share a narrow maintenance-commit classifier.
Epoch publication requires its exact canonical paths, signed finalized epoch and
receipt, original cutoff and a live non-revoked terminal epoch. Reusing a finalized
epoch under another writer-like commit subject is refused. Passing evidence refreshes
must preserve the entire checklist except verification evidence, retain prior
intent coverage and authenticate every replacement through the strict V5 receipt
verifier. Tracked causal receipt/index projections are verified against their signed, content-addressed records; the index remains append-only. Owner-lease bookkeeping is not review or ownership-transfer authority. This classifier retains lineage only; ordinary scope, material,
review, intent freshness and certification gates still decide authority.

Official certification admission additionally preserves only the exact finalized
inventory consumption delta bound to its admitted window. Routine validation
requires append-only closeout receipts bound to the changed artifact bytes and
parent commit. TEST publication must satisfy the existing exact REVIEW-to-TEST
index transition validator. These checks retain code review; they do not grant
certification or validation PASS authority.

Managed critic consumption checks the current signed inventory subject and uses
the launch digest already authenticated by the immutable managed execution seal.
It does not relaunch the reviewer or reconstruct a changed prompt. Launch still
requires OPEN; cancelled, invalidated, tampered and mismatched subjects fail closed.

Run `npm run test:review-epoch-certification-continuity` after building. Disposable
fixtures exercise actual reviewer and finalization handlers, managed lineage,
authenticated evidence refresh, forged publishers, wrong paths, cancellation and
certification admission, routine validation and actual TEST publication. Native fixture identities and local Lab records are test
provenance; they are not independent vendor audits or formal Story completion.

## Independent audit repair follow-up

Claude invocation 2e094f2f-a8f9-49e0-af33-9b345128c7a3 rejected prepared candidate d8ae4ede1ffcb3b5bb21e83e627c2a476a704801. Its findings are retained in the local Lab audit record. The repair removes the missing managed-prompt seal fallback; missing/malformed seals fail closed. Finalized critic consumption requires the terminal wave and the epoch Story identity. Epoch publication preserves prior review collection prefixes. Causal output files are checked against the SHA-256 of the exact output string (the existing store address contract, not the JSON wrapper), with a valid same-tree receipt reference. Incidental protocol paths are refused if closeout policy classifies them as gate artifacts. The TEST comparison derives its round from the original immutable reviewed commit, rather than the proposed transition. Its negative controls independently corrupt stable fields, event count, event keys and round while starting from REVIEW.

Managed fixture capacity and completion have separate bounded deadlines. Nonterminal timeout cancels the actual run and reports a distinct completion timeout. Capacity refusal is already terminal and creates no provider; it is retained, never skipped, and each retry obtains a fresh dispatch and ReviewRun. This synthetic runner does not invoke a production model. The broader smoke failure is reported as an unresolved baseline observation, not evidence that this fixture's transport is broken. The notes provide bounded unchanged dependency excerpts for independent context. No production admission or deadline is relaxed.

## Coverage-preserving refresh follow-up

Claude invocation 8a6cbaf7-e675-4ccc-9cf1-8a2e1f70fcc1 rejected a87c16cb997cf0aa223ac8e42b6bb6a287b7a936 with one medium and one low finding about coverage-changing publication. A retained refresh now requires identical covered intent references, evidence kind and result, and strict mechanical authority for both previous and replacement rows. New coverage and failure-to-pass upgrades require another review. The canonical checklist closeout policy names direct evidence publication explicitly, but only the shared strict refresh classifier can retain it; a generic closeout writer receipt alone cannot. Composite-scope retention also verifies each current causal projection against its exact committed bytes and the same complete refresh proof. Uncommitted or unrelated projections remain refused.

The regression now records an actual managed ReviewRun with a scope contract and milestone ledger and asserts that its compositeScopeDigest exists, so scoped retention cannot silently short-circuit. Negative controls add optional previously uncovered intent evidence through the real CLI and check managed lineage plus the PRE_CERT blocker; a changed recorded-result boundary is also refused. The closeout-trust smoke failed at the same validate/test_story writer assertion in both the Lab and a contemporaneous main run. Both logs are retained as a baseline observation, not a claimed passing regression.

## Unchanged dependency context for independent audit

Bounded exact source excerpts; SHA-256 binds each complete file. These excerpts supply dependency context, not independent audit or test evidence.

packages/main/src/core/closeout-trust.ts — SHA-256 c24223d36ad4f6600f22b04370c166f2f70517dff081c080d4062418ec62611a, lines 40-87

```ts
/**
 * Gate-trusted lifecycle metadata is deliberately smaller than the lifecycle
 * path registry. Recognition as ProofOrStop-owned metadata never grants trust.
 * `milestone-closeout.json` is intentionally absent: B-9188 owns that artifact.
 */
export const CLOSEOUT_ARTIFACT_POLICIES = [
  { path: 'scope-contract.json', artifactClass: 'scope-defining', canonicalWriters: ['scope_contract_set', 'scope_contract_acknowledge'] },
  { path: 'milestone-ledger.json', artifactClass: 'scope-defining', canonicalWriters: ['milestone_ledger_set', 'milestone_ledger_add', 'intent_collision_set'] },
  { path: 'slice-plan.json', artifactClass: 'scope-defining', canonicalWriters: ['slice_plan_set'] },
  { path: 'topology-critic-receipt.json', artifactClass: 'closeout-evidence', canonicalWriters: ['topology_critic_receipt_set'] },
  // A stale-evidence refresh only re-executes already-pinned verification and
  // replaces its evidence rows; it cannot create or change verification intent.
  // Direct evidence publication is retained only by the strict V5 refresh
  // classifier below: identical covered refs/results and unchanged requirements.
  // Other checklist writers require re-review.
  { path: 'checklist.json', artifactClass: 'closeout-evidence', canonicalWriters: ['verification_evidence_refresh_stale', 'verification_evidence_add'] },
  { path: 'parent-ledger-rollup.json', artifactClass: 'closeout-evidence', canonicalWriters: ['parent_ledger_rollup_set'] },
  { path: 'evidence/delivery-context-pack.json', artifactClass: 'closeout-evidence', canonicalWriters: ['delivery_context_pack'] },
  { path: 'test-evidence.json', artifactClass: 'closeout-evidence', canonicalWriters: ['validate', 'test_add', 'test_story'] },
  { path: 'done-required-evidence.json', artifactClass: 'closeout-evidence', canonicalWriters: ['done_required_validate'] },
  { path: 'delivery-check.json', artifactClass: 'closeout-evidence', canonicalWriters: ['delivery_check_set', 'delivery_waiver_add'] },
  { path: 'eval-evidence.json', artifactClass: 'closeout-evidence', canonicalWriters: ['evaluate_save'] },
  { path: 'summary.json', artifactClass: 'closeout-evidence', canonicalWriters: ['summary_set'] },
  { path: 'evidence/live-smoke-transcript.json', artifactClass: 'closeout-evidence', canonicalWriters: ['live_smoke_transcript'] },
] as const satisfies readonly CloseoutArtifactPolicy[];

export function closeoutArtifactPolicyFor(path: string): CloseoutArtifactPolicy | null {
  return CLOSEOUT_ARTIFACT_POLICIES.find((entry) => entry.path === path) ?? null;
}

export function assertCanonicalCloseoutWrite(path: string, writer: string): CloseoutArtifactPolicy {
  const policy = closeoutArtifactPolicyFor(path);
  if (!policy) throw new Error(`untrusted closeout artifact path: ${path}`);
  if (!policy.canonicalWriters.includes(writer)) {
    throw new Error(`non-canonical writer for ${path}: ${writer}`);
  }
  return policy;
}

export function isCanonicalCloseoutEvidenceWrite(path: string, writer: string): boolean {
  try {
    return assertCanonicalCloseoutWrite(path, writer).artifactClass === 'closeout-evidence';
  } catch {
    return false;
  }
}

function stable(value: unknown): string {
```

packages/main/src/core/closeout-trust.ts — SHA-256 c24223d36ad4f6600f22b04370c166f2f70517dff081c080d4062418ec62611a, lines 495-534

```ts
  artifactPath: string;
  artifactBytes: string | Buffer;
  projectRoot?: string;
  metadataRoot?: string;
}): { ok: boolean; reason?: string } {
  if (!receipt || !isCloseoutWriteReceiptSchema(receipt.schemaVersion)) return { ok: false, reason: 'invalid receipt schema' };
  if (receipt.storyId !== expected.storyId || receipt.artifactPath !== expected.artifactPath) return { ok: false, reason: 'receipt story/path mismatch' };
  try { assertCanonicalCloseoutWrite(receipt.artifactPath, receipt.writerCommand); }
  catch (error) { return { ok: false, reason: String((error as Error).message) }; }
  const { integrityHash, ...unsigned } = receipt;
  if (!integrityHash || integrityHash !== computeCloseoutWriteReceiptIntegrity(unsigned)) return { ok: false, reason: 'receipt integrity hash mismatch' };
  if (receipt.artifactDigest !== rawArtifactDigest(expected.artifactBytes)) return { ok: false, reason: 'receipt artifact digest mismatch' };
  for (const field of ['timestamp', 'phase', 'headHash', 'materialHash', 'storyFilesHash'] as const) {
    if (!receipt[field]?.trim()) return { ok: false, reason: `receipt ${field} missing` };
  }
  if (Number.isNaN(Date.parse(receipt.timestamp))) return { ok: false, reason: 'receipt timestamp is invalid' };
  if (expected.projectRoot) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', receipt.headHash, 'HEAD'], {
        cwd: expected.projectRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return { ok: false, reason: 'receipt headHash is not an ancestor of current HEAD' };
    }
    const metadataRoot = expected.metadataRoot ?? expected.projectRoot;
    if (currentMaterialHash(expected.projectRoot, receipt.headHash, metadataRoot) !== receipt.materialHash) {
      return { ok: false, reason: 'receipt materialHash is incoherent with headHash' };
    }
    if (currentStoryFilesHash(expected.projectRoot, receipt.headHash, metadataRoot) !== receipt.storyFilesHash) {
      return { ok: false, reason: 'receipt storyFilesHash is incoherent with headHash' };
    }
  }
  return { ok: true };
}

function validReceiptChain(receipts: CloseoutWriteReceipt[], storyId: string, artifactPath: string): boolean {
  const artifactReceipts = receipts.filter((item) => item.artifactPath === artifactPath);
  if (artifactReceipts.some((item) => !isCloseoutWriteReceiptSchema(item.schemaVersion))) return false;

```

packages/main/src/core/causal-evidence.ts — SHA-256 447e2885ec26d7e0c83f0b5cdbd6a39068b572e0cdebe46f6efdec8117d8cbc7, lines 28-38

```ts
export const CAUSAL_LEDGER_SCHEMA = 'proof-or-stop.causal-evidence-ledger.v1' as const;
export const CAUSAL_PREFLIGHT_SCHEMA = 'proof-or-stop.causal-evidence-preflight.v1' as const;
export const CAUSAL_DEPENDENCY_SCHEMA = 'proof-or-stop.causal-dependency-decision.v1' as const;
export const CAUSAL_RECEIPT_DIRECTORY = 'causal-evidence/receipts';
export const CAUSAL_OUTPUT_DIRECTORY = 'causal-evidence/outputs';
export const CAUSAL_RECEIPT_INDEX_FILE = 'causal-evidence/index.json';
export const CAUSAL_AUTHORITY_KEY_FILE = 'proof-or-stop-causal-evidence-authority-v1.key';
export const CAUSAL_OUTPUT_TAIL_CHARS = 4_000;
export const CAUSAL_MAX_OUTPUT_CHARS = 12_000;
export const CAUSAL_SELECTOR_OUTPUT_BOUND_BYTES = 1024 * 1024;
export const CAUSAL_PREFLIGHT_CHECK_NAMES = [
```

packages/main/src/core/causal-evidence.ts — SHA-256 447e2885ec26d7e0c83f0b5cdbd6a39068b572e0cdebe46f6efdec8117d8cbc7, lines 662-684

```ts
// Weak ownership retains failed/non-persistent execution output only while its receipt is live.
const liveSelectorOutput = new WeakMap<CausalEvidenceReceipt, string>();

export function readCausalSelectorOutput(receipt: CausalEvidenceReceipt, store?: CausalEvidenceReceiptStore): string {
  if (!receipt.selectorOutput) {
    if (receipt.selectorProbe !== undefined) return receipt.selectorProbe;
    // Historical receipts contain display bytes only. Truncation/redaction markers
    // have no raw-output provenance and must never become selector evidence.
    if (receipt.outputLength > CAUSAL_MAX_OUTPUT_CHARS
        || [receipt.outputProbe, receipt.outputTail].some(value => value.includes(REDACTED) || value.includes('<causal-output-gap>'))) {
      throw new Error('Legacy display output cannot prove this selector; fresh execution is required [causal_legacy_selector_output_unproven]');
    }
    return receipt.outputProbe;
  }
  const output = liveSelectorOutput.get(receipt) ?? store?.readCausalSelectorOutput?.(receipt.storyId, receipt.selectorOutput.digest);
  if (typeof output !== 'string' || output.length !== receipt.selectorOutput.length
      || createHash('sha256').update(output).digest('hex') !== receipt.selectorOutput.digest) {
    throw new Error('Complete selector output is missing or changed [causal_selector_output_invalid]');
  }
  return output;
}

function selectorVerdict(
```

packages/main/src/core/store.ts — SHA-256 d30f0483c6113dce4004fdb8a0d662ec35d85fb1e500125ab8ae831439a3e4fc, lines 921-946

```ts
  readCausalSelectorOutput(storyId: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid output address [causal_selector_output_invalid]');
    try {
      const data = JSON.parse(readFileSync(this.storyFilePath(storyId, `${CAUSAL_OUTPUT_DIRECTORY}/${digest}.json`), 'utf8'));
      if (typeof data.output !== 'string') throw new Error('Invalid output type');
      return data.output;
    } catch {
      throw new Error('Complete selector output is missing or unreadable [causal_selector_output_invalid]');
    }
  }

  writeCausalSelectorOutput(storyId: string, digest: string, output: string): void {
    return withValidationMetadataWrite(this.projectRootValue, storyId, () => {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid output address [causal_selector_output_invalid]');
      const outputPath = this.storyFilePath(storyId, `${CAUSAL_OUTPUT_DIRECTORY}/${digest}.json`);
      // The execution-key lock serializes producers; equal content addresses can
      // also be produced by different keys, where identical bytes are harmless.
      if (existsSync(outputPath)) {
        if (this.readCausalSelectorOutput(storyId, digest) !== output) throw new Error('Output address collision [causal_selector_output_invalid]');
        return;
      }
      this.writeJsonFile(outputPath, { output });
    });
  }

  /** Read-only callers may verify an orphan receipt without rebuilding its index. */
```

packages/main/src/core/review-metadata-batch.ts — SHA-256 452ff103a198aa858bb717a1f5dec82ceb82c1bb356097b740504aaca54ffbf9, lines 14-21

```ts
/** Exact review storage surface; never sweep unrelated staged files or Story authoring. */
export const REVIEW_EPOCH_COMMIT_ARTIFACTS = [
  'review-runs.json', 'prompt-envelopes.json', 'review-passes.json',
  'findings.json', 'finding-ledger.json', 'review-inventory-epochs.json',
  'convergence-progress.json', 'process-events.jsonl', 'process-metrics.json',
] as const;

/** Called only after individual signed results have passed durable readback. */
```

packages/main/src/core/certification-window.ts — SHA-256 3542fe7de8df26a862d5a39d0046cd5cf2e600d6b89c53f8aef764f628d0ad28, lines 330-365

```ts
export function isCertificationWindowState(value: unknown): value is CertificationWindowState {
  return typeof value === 'string' && (CERTIFICATION_WINDOW_STATES as readonly string[]).includes(value);
}

export function signCertificationWindow(window: Omit<CertificationWindow, '_hash'>): string {
  return certificationWindowDigest({ domain: WINDOW_DOMAIN, ...window });
}

export function verifyCertificationWindow(window: CertificationWindow): boolean {
  if (!window || window.schemaVersion !== CERTIFICATION_WINDOW_SCHEMA) return false;
  if (!window._hash || !isCertificationWindowState(window.state)) return false;
  const { _hash, ...unsigned } = window;
  return _hash === signCertificationWindow(unsigned);
}

export function signPrecertReceipt(receipt: Omit<PrecertReceipt, '_hash'>): string {
  return certificationWindowDigest({ domain: RECEIPT_DOMAIN, ...receipt });
}

export function verifyPrecertReceipt(receipt: PrecertReceipt): boolean {
  if (!receipt || receipt.schemaVersion !== PRECERT_RECEIPT_SCHEMA) return false;
  if (!receipt._hash || receipt.authority !== PRECERT_AUTHORITY) return false;
  if (receipt.authorizesHeavyCertification !== true) return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signPrecertReceipt(unsigned);
}

export function signPrecertCheapCheckReceipt(
  receipt: Omit<PrecertCheapCheckReceipt, '_hash'>,
): string {
  return certificationWindowDigest({ domain: CHEAP_CHECK_RECEIPT_DOMAIN, ...receipt });
}

/**
 * A cheap receipt must prove exactly the focused profile.  In particular, a
 * syntactically valid identity for a full, channel, concept, lint, or other
```

packages/main/src/core/review-inventory-epoch.ts — SHA-256 613ef82656e7d81acf513c0ac5f1debfff8862821fdf15abe84bcb9095bddce5, lines 85-125

```ts
/** Canonical acceptance/review subject shared by epoch writers and consumers. */
export function reviewInventoryAcceptanceSubjectDigest(
  scopeContract: unknown,
  checklist: ChecklistData,
  proofStoryContract: Record<string, unknown> | null = null,
  scopeShrinkageDecision: Record<string, unknown> | null = null,
  authentication?: { projectRoot: string; storyId: string },
): string {
  // One rule, three shapes: this helper, evidenceSemantics below, and the candidate
  // projection in handlers/review-inventory.ts captureReviewInventoryScope all bind
  // SEMANTIC CONTENT and drop BOOKKEEPING, so an idempotent retry or a pure re-pin
  // cannot manufacture acceptance drift. They stay separate because the shapes differ
  // (flat record / nested per-row array / a different artifact in another module);
  // unifying them would need an over-general abstraction. Each was driven by its own
  // independently-found defect: B-3f3d F-099, F-103/F-104, F-107.
  const withoutVolatileTimestamps = (value: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!value) return null;
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...semantic } = value;
    return semantic;
  };
  // B-3f3d F-099: bind what a verifier OBSERVED, not when it last ran. A pure
  // `verification_evidence_refresh_stale` re-pin rewrites headHash/materialHash/
  // storyFilesHash/timestamp (and receipt.executedAt) while result/command/note/
  // outputDigest stay identical. Hashing those freshness pins made an evidence
  // re-pin flip this digest and trip OPEN_REVIEW_INVENTORY_SCOPE_MUTATION, even
  // though currentMaterialHash already excludes the whole .proof-or-stop/story/ tree —
  // so a metadata-only refresh invalidated an OPEN epoch and discarded other
  // lanes' completed verdicts. Same principle as withoutVolatileTimestamps above:
  // semantic content in, bookkeeping out. Anything that should still invalidate
  // (a changed result, command, selector or captured output) remains bound.
  const evidenceSemantics = (value: unknown, item: ChecklistData['items'][number]): unknown => {
    if (!Array.isArray(value)) return value;
    const currentIntents = item.verificationIntent ? collectVerificationIntents(item) : [];
    return value.filter(row => {
      if (!item.verificationIntent) return true;
      if (!row || typeof row !== 'object') return true;
      const intentRef = (row as Record<string, unknown>).intentRef;
      return typeof intentRef !== 'string' || currentIntents.some(intent => intent.ref === intentRef);
    }).map(row => {
      if (!row || typeof row !== 'object') return row;
      const {
```


## Third audit follow-up

Audit ec26e2c2-1a66-4187-bb7e-e4674449138e rejected the duplicate-reference
comparison. Refreshes now preserve the complete semantic multiset of intent
reference, kind and result. Exact unchanged rows are consumed first; changed
rows consume authenticated prior rows one to one. A prior PASS cannot authorize
multiple replacements or conceal a recorded FAIL among duplicate references.
The pinned fixture adds this counterexample and exercises invalid persisted
managed launch seals through the actual REVIEW evidence collector.

The fixture reconstructs the real validate publication and tests receipt
sequence, previous integrity hash, parent HEAD, duplicate receipt count and
prior-prefix replacement. Integrity hashes are recomputed for single-field
controls so refusal tests more than a stale checksum.

The four incidental bookkeeping files deliberately confer no authority through
this classifier. Their content is ignored even alongside an authentic validate
publication; this does not validate telemetry, authorize certification or replace
any specialized gate. The mixed forged test-runs plus authentic evidence case
explicitly preserves code-review lineage, while telemetry alone remains refused.
A future closeout policy classification of any incidental path fails closed.
