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

Claude invocation 8a6cbaf7-e675-4ccc-9cf1-8a2e1f70fcc1 rejected a87c16cb997cf0aa223ac8e42b6bb6a287b7a936 with one medium and one low finding about coverage-changing publication. A retained refresh now requires identical covered intent references, evidence kind and result, and strict mechanical authority for both previous and replacement rows. New coverage and failure-to-pass upgrades require another review. Direct evidence publication is excluded from generic canonical checklist writers; only the shared strict refresh classifier can retain it; a generic closeout writer receipt alone cannot. Composite-scope retention also verifies each current causal projection against its exact committed bytes and the same complete refresh proof. Uncommitted or unrelated projections remain refused.

The regression now records an actual managed ReviewRun with a scope contract and milestone ledger and asserts that its compositeScopeDigest exists, so scoped retention cannot silently short-circuit. Negative controls add optional previously uncovered intent evidence through the real CLI and check managed lineage plus the PRE_CERT blocker; a changed recorded-result boundary is also refused. The closeout-trust smoke failed at the same validate/test_story writer assertion in both the Lab and a contemporaneous main run. Both logs are retained as a baseline observation, not a claimed passing regression.

## Unchanged dependency context for independent audit

Bounded exact source excerpts; SHA-256 binds each complete file. These excerpts supply dependency context, not independent audit or test evidence.





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

The third round initially documented unchecked incidental telemetry. The fourth
round supersedes that boundary: owner session/workspace identity must remain
unchanged, malformed test-run projections are refused, and process metrics must
retain their Story subject. The mixed forged-telemetry regression now refuses.

## Fourth audit follow-up

Audit 322cc98c-bb07-4333-840f-bd04281d252b produced seven findings. Generic
checklist receipt builders now reject verification_evidence_add structurally;
only the strict byte-bound classifier can retain the artifact. The fifth-round
follow-up below removes the intermediate caller-provided boolean entirely. Direct positive and negative assertions
exercise both boundaries. Baseline closeout-trust writer-oracle failure is routed
through docs/story/drafts/closeout-trust-validate-writer-oracle (official CLI,
main commit 862001802d). gap_log failed invalid_binding_shape; no provenance
record was forged and no full-suite success is claimed.

Finalization preserves prior epochs and receipts, allowing only the target
OPEN-to-FINALIZED replacement. Finding-ledger records and receipts and convergence
completed/revoked/human-decision histories preserve prefixes. Current convergence
state and open-finding projections are recomputed rather than append-only.
Tests independently delete each ledger history and prior epoch/receipt after a
positive preservation control. Historical markers in this disposable fixture
are byte-preservation controls, not claimed independent reviewer authority.

The owner check binds session identity, identity source, host and workspace,
allowing only heartbeat and PID updates while preserving every other field. The fixture releases
its own lease between child calls and now preserves the actual committed prior
lease for comparison. Malformed validation test-run projections are refused and epoch/validation metrics
must bind the Story. Test-run history is shape-checked, not authenticated or
append-only in this classifier. Typed telemetry readers are handlers/story-query.ts and
handlers/session.ts (rendering), handlers/review-remediation.ts (metrics update),
handlers/summary.ts (fixture statistics), and core/process-metrics.ts (derived
scores). This classifier does not authenticate those telemetry values or use
them to issue validation PASS; closeout evidence remains separately receipted.
Both evidence-refresh and generic branches refuse future closeout-policy claims
on incidental files.

review-evidence-refresh.ts, review-test-index-transition.ts and
review-metadata-surface.ts separate strict refresh, exact index comparison and
metadata paths from their consumers, removing the newly introduced direct
importer cycles. Malformed inventory reads return a structured invalid result;
unexpected maintenance reader errors report health diagnostics and refuse.

Prepared-candidate provenance: the Lab finish command records GREEN before
release preparation, then creates the version/CHANGELOG-only preparation commit
and replays the same pinned command on that exact candidate before invoking
Claude. Source behavior is unchanged by release preparation apart from the
required CLI version constant. The signed Lab record stores a candidate-green history entry and
its exact HEAD; CHANGELOG cannot self-reference its own future commit hash.


packages/main/src/core/verification-receipt-authority.ts — SHA-256 3f988b87bbe517d18c72468b63496d314b1f27ddd48fa3226eda87cd0fd484ff, lines 1-25

```ts
/** Exact authenticated execution identity shared by remediation and progress observation. */
import type { StoryStore } from './store.js';
import type { ChecklistItem, VerificationEvidence } from './types.js';
import { collectVerificationIntents } from './verification.js';
import { validateVerificationReceipt } from './verification-execution-evidence.js';

export function hasMechanicalExecutionAuthority(store: StoryStore, storyId: string, item: ChecklistItem, evidence: VerificationEvidence): boolean {
  const executed = evidence.receipt;
  const pin = collectVerificationIntents(item).find(i => i.ref === evidence.intentRef)?.intent.verification;
  if (evidence.mechanical !== true || evidence.result !== 'pass' || evidence.kind === 'waiver'
    || !executed || executed.exitCode !== 0 || executed.selectorMatched !== true
    || !pin || !pin.selector || pin.command !== evidence.command || pin.selector !== executed.selector
    || !evidence.headHash || !evidence.materialHash || !evidence.storyFilesHash) return false;
  try {
    const validation = validateVerificationReceipt(store.projectRoot, executed, {
      storyId, intentRef: evidence.intentRef, command: pin.command, selector: pin.selector,
      freshness: { headHash: evidence.headHash, materialHash: evidence.materialHash, storyFilesHash: evidence.storyFilesHash },
    });
    // Readable legacy bundles do not authenticate publication scope or freshness.
    // Reuse eligibility is independent of authority for this recorded execution.
    return validation.ok && validation.kind === 'split-v5';
  } catch (error) {
    throw new Error(`Execution authority verifier unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
```


packages/main/src/core/certification-window.ts — SHA-256 3542fe7de8df26a862d5a39d0046cd5cf2e600d6b89c53f8aef764f628d0ad28, lines 1467-1482

```ts
export function isCertificationRunningOnlyAdvance(before: CertificationWindowData, after: CertificationWindowData, storyId: string): boolean {
  if (!before || !after || before.schemaVersion !== CERTIFICATION_WINDOW_FILE_SCHEMA || after.schemaVersion !== before.schemaVersion) return false;
  if (!Array.isArray(before.windows) || !Array.isArray(after.windows) || before.windows.length === 0 || before.windows.length !== after.windows.length) return false;
  if (!Array.isArray(before.receipts) || !Array.isArray(after.receipts) || !isDeepStrictEqual(before.receipts, after.receipts)) return false;
  const prior = before.windows.at(-1)!;
  const next = after.windows.at(-1)!;
  if (prior.storyId !== storyId || next.storyId !== storyId || prior.state !== 'ADMITTED' || next.state !== 'RUNNING') return false;
  if (!verifyCertificationWindow(prior) || !verifyCertificationWindow(next)) return false;
  const receipt = before.receipts.find(row => row.receiptId === prior.receiptId);
  if (!receipt || receipt.schemaVersion !== PRECERT_RECEIPT_SCHEMA || !verifyPrecertReceipt(receipt) || !windowAuthorizesHeavyCertification(prior, receipt)) return false;
  if (!Number.isFinite(Date.parse(next.updatedAt)) || Date.parse(next.updatedAt) < Date.parse(prior.updatedAt)) return false;
  return isDeepStrictEqual(after, {
    ...before,
    windows: [...before.windows.slice(0, -1), { ...prior, state: 'RUNNING', updatedAt: next.updatedAt, _hash: next._hash }],
  });
}
```


## Fifth audit follow-up

Audit 945ac0f1-9b7f-48e6-b335-436ad2df342c rejected the parent-only projection
and repeated-scan implementation. Strict refresh now compares both unchanged
requirements and the complete covered-result multiset with the original signed
review HEAD, as well as authenticating the parent and replacement executions.
A genuine refresh following an unreviewed title change is explicitly refused.
The current-artifact reader no longer obtains a dead parent hash argument.

The scoped reader recomputes strict proof before excluding checklist/causal
projections from ordinary closeout evaluation. The ordinary pure evaluator has
no strictEvidenceRefresh boolean or special direct-writer exception; a manually
constructed boolean input is refused. Generic receipt authority remains narrow.

A collector creates one opaque read-cache token. Only the refresh module can
populate its private verdict maps. Commit verdicts bind immutable commit and
reviewed hashes, while current artifact bytes are checked on every read. Each
commit builds its output-digest receipt index once. The regression populates
200 signed history receipts with actual bounded sequential Node commands, then
checks a one-proof/subprocess-count bound across repeated artifact reads. Those
history receipts are attached to no acceptance intent and do not represent
provider work or independent review. Measured command durations use the clock.

Lease comparison now permits exactly PID/heartbeat updates, rejecting changed
Story identity and previously absent fields. The disposable CLI wrapper restores
only its same logical session's genuinely committed lease before the next child,
rather than recreating its acquisition fields. Required finding-ledger records
and receipts remain required by LedgerEnvelope; omission is deliberately refused
and now has a counterexample. Optional convergence humanDecisions remains empty
when absent.

The fifth follow-up temporarily used isolatedHeavy CPU/process claims; the sixth
audit exposed unmeasured serialization, and the final policy below preserves
baseline shared repo-read scheduling. External
capacity exhaustion yields an explicit admission-retry-required diagnostic;
required proof is never silently skipped or counted as PASS.

The dedicated 200-receipt case batches immutable Git objects and measured 28
Git subprocesses with one full commit proof; repeated artifact reads added no
subprocesses. The earlier per-object implementation used 225 calls in that
reader case. This count compares the reader only, not whole-Story elapsed time.
The combined 200-receipt lifecycle matrix previously timed out at 420 seconds;
the passing regression now restores the original small witness before running
its lifecycle counterexamples. Full large-Story throughput remains unproven.

## Sixth audit follow-up

Audit 32aa9f50-4645-4969-9259-cffeb05ddad3 identified late-start managed runs
and historical inventory waves as missing production cases. Epoch publication
now requires cutoff ancestry and exact material/Story hashes when the consumer
started later. The regression uses an actual non-deferred finding_resolve publication inside
the OPEN epoch before two managed roles launch, and refuses wrong hashes and a
pre-cutoff consumer. OPEN reviewer/importer writes are normally batch-deferred.
A mixed evidence-plus-inventory initialization commit remains explicitly refused
as impure refresh; the regression preserves that refusal instead of widening
the strict evidence writer.

A real two-wave case uses brokered Finding production for a genuine disposable
source-contract defect, actual managed critics and official wave advancement.
The deliberately negative source fixture receives a truthful accepted-risk
disposition through the real CLI before either managed critic launches; no fix
is claimed. Its signed discovery remains in inventory history. An old wave is
superseded only after its receipt authenticates and a newer
valid lane PASS exists. Removing that replacement remains blocked; tampering
with the old sealed launch remains a hard receipt failure.

The unused generic classifier extension was deleted. Positive and negative
refresh assertions now call production evaluateReviewRunMetadataRetention.
closeout-trust retains its type-only StoryStore import and no longer imports
review-evidence-refresh, removing the added transitive store edge. The process
contract checks this edge explicitly. The extracted canonicalJson import was
removed from review-run. Epoch metrics receive the same Story/shape guard as
validation metrics, with a genuine publication mutation control.

The suite member keeps its baseline shared repo-read claims with a 450-second
outer cap above the isolated worker's 420-second bound. This adopts the sixth
auditor's explicit alternative to adding an exclusive heavy-chain claim; normal
provider admission remains enforced and fixture commands execute sequentially.
No new machine pool, capacity override or broader global suite budget is used.

Default-job npm test was attempted on repair 70a825faa9 and main 1da6c8e86e.
Both failed before this member ran, at full-suite-runner-smoke with the same
nested ancestor machine-resource conflict. Lab elapsed 19998 ms; main 22803 ms.
Only 1/75 passed, so these are aborted measurements and establish no complete
suite wall clock or PASS. The official draft full-suite-nested-machine-resource-owner
routes this pre-existing scheduler failure. The baseline parallel scheduling
choice avoids the new serialization risk without repairing unrelated scheduler
code or hiding the failed measurement.


## Eighth bounded repair after actual audit 40d44c17

Actual Claude audit of 1aa214e8a0 returned five findings in 578838 ms. It
confirmed the core launch seal, one-to-one V5 result/coverage preservation,
publication history and wave supersession protections. The candidate was
reopened; no integration was claimed.

Ancestry exit 1 now returns an explicit negative verdict; other Git failures
still reach the health reporter. A shared missing-snapshot predicate recognizes
both Git absent-path wordings. Lease/checklist parent reads are existence-guarded.
The regression redirects the actual health writer through its supported test
path, checks the path, proves normal refusals emit no anomaly and an invalid
commit emits one. It adds first-parent lease/checklist publication controls.

The persisted ConvergenceProgressJournal in core/convergence-progress-journal.ts
requires completedEpochBindings and revokedCompletedEpochIds; humanDecisions is
optional. The process contract pins these exact declarations:

```ts
completedEpochBindings: { epochId: string; claimDigest: string }[];
revokedCompletedEpochIds: string[];
humanDecisions?: { reason: string; completedEpochIds: string[]; snapshotDigest: string }[];
```

The regression calls recordConvergenceProgress to obtain the real producer
shape, then constructs disposable historical prefix sentinels. Those sentinels
are not claimed as valid completed-epoch authority. Positive prefix preservation,
each field's erasure, absent optional parent field and missing required next
field are exercised through the maintenance classifier. Other convergence gates
retain their authority checks. Consumption no longer supplies an inert prompt
digest; legacy caller shapes remain source-compatible via an optional field.
The real three-way sealed digest comparison stays mechanically pinned. The
unreachable certification allowlist branch is removed; the shared strict reader
continues to enforce that allowlist.

### Measured watchdog and concurrency boundary

The seventh-variant recorded passes were 271801 ms at 722a066079, 266625 ms at
745bd838d4 and 224343 ms at prepared 1aa214e8a0. The eighth standalone regression
44 passed in 188552 ms with source frozen. The registered standalone watchdog is
360000 ms, retaining 88199 ms (32.4%) margin above the slowest seventh pass. It
scales from the scheduler's post-admission outer budget, up to 540000 ms, and is
clamped to its absolute remaining deadline minus 30000 ms. Invalid/expired
transport refuses. Production provider admission, resource pools, global suite
budget and canonical membership are unchanged. Runtime contracts pin writer and
reader; fast assertions cover standalone, concurrency, queue/startup delay and
invalid/expired envelopes. This is a test watchdog, not new authority.

A real canonical three-member jobs=3 subset was run with the unchanged scheduler,
resource claims, machine admission, build binding and cancellation policy:
review-epoch-certification-continuity, proofstory-acceptance-rollout and
flow-stability-smoke. The first heavy member PASSED in 231942 ms. Continuity
received 539991 ms inner / 674989 ms outer and overlapped that member for
231920 ms, but FAILED after 274635 ms at its FIRST verification_evidence_add.
Its internal CLI waited in machine admission and returned its existing deadline
error; the 539991 ms watchdog did not expire. The next heavy member was normally
cancelled. This establishes actual overlap and transport observation, not a
completed concurrent continuity PASS or full-suite PASS.

The existing runSingleAllowlistedCommand builds a validation command without
resource claims; its unknown leaf requests the exclusive machine barrier while
the enclosing full-suite entry retains its classified shared barrier. The
existing full-suite-nested-machine-resource-owner draft owns that nested resource
follow-up (main 5fc1e8d458). The earlier exact default-job npm test failures were
reproduced on main too. This Lab does not reclassify unknown leaf work as safe,
create private provider pools, release another holder or repair global scheduling.
Raw subset outcomes, received budgets and overlap spans are retained externally
in review-finalization-concurrency-subset.json; standalone and failure logs are
preserved. Complete concurrent execution remains an explicit limitation for the
next independent auditor to assess, not evidence of reduced resource consumption.


A bounded same-API detached-child witness subsequently reproduced the exact
nested barrier mechanism on both main a8240a60bd and this Lab. Both relevant
source files and served modules were byte-identical. The actual unknown-resource
leaf ticket was observed behind the diagnostic's own shared outer ticket; the
leaf's parent was PID 1. Main/Lab refused in 903/902 ms under a bounded deadline;
after releasing only the diagnostic's own outer holder, the identical Node leaf
executed successfully in 116/92 ms. The forwarded 10-second deadline label on
that sub-second refusal also reproduced the misleading timeout wording. Own
workers and tickets were verified absent afterward. There were no provider
launches, private pools, admission overrides or real Story changes. External
nested-machine-admission-diagnostic-report.md and its JSON retain the actual
observations. This strengthens the existing baseline route; it does not prove
successful concurrent headroom. Independent audit must assess that limitation.

Eighth repair build and runtime contract passed. Process contract 20 passed after
retargeting a second old certification assertion from dead branch text to the
actual shared strict reader. The normal-refusal health regression also includes
a genuine invalid-commit anomaly control through the actual health output path.
