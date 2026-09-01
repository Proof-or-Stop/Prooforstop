# Dynamic Finding System Execution Plan

Status: approved execution plan; specification only

Story: B-1fa6

Created: 2026-08-30

Scope: future implementation Stories; this document does not implement schemas,
commands, persistence, gates, package renames, or historical-data migration.

## 1. Executive decision

Proof-or-Stop should build a **Dynamic Finding System**, but "dynamic" must not
mean that an old Finding silently changes truth, severity, or outcome. The
durable Finding remains the observation. A separate, signed, target-Story
assessment answers whether that observation is applicable to the current Story,
current scope, current material, and current runtime evidence, and who owns it
when it is not the current Story.

The program has exactly four responsibility components:

1. **Finding Ledger Integrity**
2. **Candidate and Defect Identity** (the `Candidate & Defect Identity`
   shorthand used in the initiating request)
3. **Dynamic Applicability**
4. **Freshness and Supersession** (the `Freshness & Supersession` shorthand
   used in the initiating request)

The complete program is intended to cover seven observed failure classes. The
Dynamic Applicability component alone does not cover all seven. In particular,
candidate noise, semantic identity, runtime-artifact provenance, historical
correction, and concurrent persistence are distinct correctness boundaries.

The implementation is deliberately decomposed into three future Stories:

1. **Dynamic Finding Applicability**
2. **Finding Identity and Historical Lineage**
3. **Finding Ledger and Runtime Evidence Integrity**

Those numbers are product-facing labels, not execution order. Safe execution is
**Story 3A -> Story 3B and Story 2; Story 3A + 3B + Story 2 -> Story 1 enforcement**. Story 1 may prototype read-only
observe output earlier, but it may not influence a lifecycle outcome until both
prerequisites are accepted in the merged state.

### 1.1 Outcome

For a Finding-heavy Story, reviewers should spend time on genuine, current,
Story-owned defects. Detector hits should be filtered before they become
Findings; repeated manifestations should share a canonical defect identity;
real but unrelated findings should retain their truth and be routed to a valid
owner; stale or tampered assessments should fail closed; and all writes should
survive concurrency and retry.

A suspected low/medium observation may be routed early as a non-authoritative
`CandidateFinding`, without promotion or root-cause work. Separately, a narrow
**defer-with-proof** disposition may let an otherwise applicable verified low or
medium Finding remain open but advisory for the current Story. Neither path is a
fifth component or a new truth state. Dynamic Applicability decides whether a
verified Finding may defer and enforces the non-resetting cumulative horizon;
Candidate and Defect Identity owns target-side non-gate route semantics and
later recall; Freshness and Supersession invalidates stale routes/deferrals; and
Finding Ledger Integrity durably commits each route and disposition.

The program can reduce classification, triage, repeated reproduction, manual
resolve/dismiss, and convergence costs. It cannot reduce the number or repair
time of genuinely applicable defects, and it must not claim that it does.

### 1.2 Non-goals of this specification Story

- Do not add a `related: boolean` field or any runtime schema.
- Do not edit `isFindingBlocking`, lifecycle guards, or process-fact registries.
- Do not bulk-rewrite the historical Finding corpus.
- Do not create the three future Stories from this document.
- Do not replace the existing review-convergence/stall adjudication mechanism.
- Do not automatically resolve, dismiss, hide, or delete a Finding.
- Do not use deferral as a waiver, an alias for `out_of_scope`, or an unowned
  backlog note.
- Do not rename package identities here; the separate identity-cutover Story
  owns that migration.
- Do not treat historical learning, a DONE result, a signature tag, a file
  overlap, or a model confidence score as lifecycle gate evidence.

## 2. Current Finding versus Dynamic Finding Applicability

The exact distinction is:

```text
Current Finding
  = a durable claim that a problem was observed, with severity, evidence truth,
    lifecycle status, reviewer provenance, and optional audit metadata.

Dynamic Finding Applicability
  = a signed, expiring projection of one Finding against one target Story's
    current scope, source material, base/head behavior, runtime artifacts,
    ownership, and routing.
```

This plan does **not** introduce a second kind of Finding. It adds a relationship
record around the existing Finding.

| Question | Current Finding answers it? | Dynamic assessment answers it? |
| --- | --- | --- |
| What problem was observed? | Yes: `desc`, `category`, `files` | No |
| How serious was the observation? | Yes: `severity` | No; it must not rewrite severity |
| Was the observation suspected, verified, or disproven? | Yes: `evidenceState` | No; it consumes the truth state |
| Is the Finding open, resolved, or dismissed? | Yes: `status` | No; a non-blocking assessment does not fake resolution |
| May a suspected low/medium observation be handed off before promotion? | No structured candidate route | Yes: an evidence-bearing, receipted `CandidateRoute` that remains non-authoritative and never enters a gate |
| Does this verified problem belong to this target Story? | No independent gate field | Yes: `verdict` |
| Did the target Story introduce or worsen it? | Not represented | Yes: base/head evidence |
| If it is not this Story's responsibility, who owns it? | Only free-text/audit outcome conventions | Yes: structured `owner` and `route` |
| May an applicable low/medium Finding be postponed without disappearing? | No structured disposition | Yes, but only through a fresh `FindingDeferralDisposition` with protected-surface checks and a receipted existing owner/route |
| Is the decision still valid after source, scope, or runtime drift? | Finding stays as history | Yes: signed freshness bindings become stale |
| Is it the same semantic defect as another Finding? | Coarse `signatureTag` and file cluster only | Canonical defect identity proposes/records equivalence |
| May it affect REVIEW -> TEST? | Current predicate reads status, severity, evidence state, and round | Only a fresh L4 assessment may add the applicability dimension |

The present type is anchored at
`packages/main/src/core/types.ts` (`Finding`). Its `signatureTag`,
`resolutionType`, `dismissReasonType`, and evidence-strength fields are expressly
audit-only and must not be read by a gate. The current shared predicate is
`packages/main/src/core/advisory.ts:isFindingBlocking`; it evaluates open state,
effective blocking severity, evidence state, and round decay. The current
`packages/main/src/core/cluster-compute.ts` clusters within one Story using
matching severity and file overlap. None of these facts represents target-Story
applicability.

This separation avoids a semantic error that exists in manual handling today:

```text
verified problem + not this Story's responsibility != resolved problem
```

A verified problem may remain open in its canonical owner while a fresh
assessment makes it non-blocking for another Story. Conversely, an old
out-of-scope decision may become in-scope after the operator changes the Story
scope. The historical record is preserved in both cases.

Deferral is deliberately separate from that verdict transition. A deferred
Finding remains `verified`, keeps its original severity, remains `open`, and is
still shown as advisory with its owner and route. It is not `out_of_scope`,
`pre_existing_unaffected`, `duplicate`, `disproven`, resolved, or dismissed.
Only a verified and applicable Finding reaches a gate-bearing repair or deferral
decision. A suspected low/medium observation may instead be routed early as a
non-authoritative candidate when its uncertainty, evidence, owner, and existing
target are explicit; this does not promote it, change Finding state, or affect a
gate. A disproven Finding is released by counter-evidence, never by deferral.
For a verified applicable low/medium Finding, current repair is the default and
defer-with-proof is the bounded exception. A verified applicable high/critical
Finding, or any protected-surface risk, must be reproduced, root-caused, fixed,
and proven Green in the current Story.

## 3. Evidence method and point-in-time corpus inventory

### 3.1 Evidence boundary

All Story/Finding evidence cited by this plan was retrieved through authorized
Proof-or-Stop CLI surfaces. The procedure does not read or parse protected Story
or Finding storage directly. Readers must use `story_list`, `finding_list`, and
the learning/source-lineage commands below. If an active Story requires its own
worktree, follow the CLI's worktree guidance and run its `finding_list` there.

Historical observations establish that a failure happened and explain why the
program is worth building. They do **not** prove that the same defect remains
unresolved at today's source HEAD. `open`, `resolved`, `dismissed`, `disproven`,
`superseded`, DONE, or routed are recorded historical outcomes, not a current
reproduction. Every future implementation Story must mint current evidence for
the behavior it claims to fix.

Three evidence authorities must remain distinct:

| Evidence layer | Example | Authority in this program |
| --- | --- | --- |
| Raw Finding provenance | CLI-returned Finding, signed review run, resolution text | Historical fact about what was recorded; current lifecycle authority only when the current gate validates it |
| Derived learning/signature material | finding signals, recall profiles, playbooks, `signatureTag` | Non-authoritative candidate material |
| Current gate evidence | signed current-material applicability assessment plus required receipts | L4 gate-consumed fact after enforcement is enabled |

`canonicalSourceKey` prevents multiple derived artifacts from pretending to be
independent sources. It does not prove that two differently worded Findings are
the same semantic defect. Semantic equivalence requires a confirmed canonical
defect decision and current evidence.

### 3.2 Dated snapshot

The following is a **point-in-time observation**, not a repository invariant:

- Observed at: `2026-08-30T22:46:28.687Z`
- Documentation worktree HEAD:
  `e3f9a3118323f8821efa986b3c36dfe5da12406f`
- Story rows returned by `story_list --json`: **367**
- Stories whose `finding_list --json` returned at least one Finding: **210**
- Total Findings: **2,273**
- Status projection: **2,184 resolved**, **72 open**, **17 dismissed**
- Severity projection: **52 critical**, **1,298 high**, **667 medium**,
  **256 low**
- Evidence-state projection: **2,257 verified**, **12 disproven**,
  **4 suspected**
- Phase projection: **2,235 DONE**, **35 META**, **3 TEST**
- Resolution type: **1,920 fixed**, **41 accepted_risk**,
  **22 partially_mitigated**, **21 superseded**, **14 duplicate**,
  and **255 missing**
- Field coverage denominator is all 2,273 Findings: **1,641** have non-empty
  `files`; **2,046** have `reviewRunId`; **2,239** have `signatureTag` and
  `signatureTagSource`; **1,887 strong**, **37 medium**, **2 weak**, and
  **347 missing** `resolveEvidenceStrength` values.
- Signature source: **2,022 auto**, **217 confirmed**, **34 missing**. The
  projection contained **1,431** unique tag strings, only **67** of which
  appeared in two or more Stories.

The CLI deliberately renders a legacy Finding with a missing `evidenceState` as
`verified`. Therefore the 2,257 figure is a **CLI compatibility projection**;
it is not proof that every underlying historical row explicitly stored that
field. Missing optional fields are reported as missing, not inferred.

High-volume examples at the same snapshot were:

| Story | Findings | Distinct non-empty `reviewRunId` values attached to those Findings |
| --- | ---: | ---: |
| B-f458 | 127 | 98 |
| B-cc10 | 81 | 46 |
| B-9ff1 | 80 | 28 |
| B-cdf6 | 71 | 44 |
| B-bf52 | 62 | 18 |
| B-3434 | 56 | 30 |

The last column is not a count of review rounds and not a count of all review
runs. It counts distinct run IDs referenced by Finding rows, excluding pass-only
runs and runs that produced no Finding. For example,
`docs/step3-review-budget-breaker-handoff.md` separately reports B-bf52's broader
event-sourced incident as 14 finding-bearing rounds / 46 review runs. Those two
measurements answer different questions and must not be substituted for one
another.

Regenerate this inventory before quoting it. New Stories, Findings, outcomes,
and active-worktree state will change the numbers.

### 3.3 CLI-only reproduction procedure

The following read-only procedure is the procedure used for the aggregate. It
parses only CLI JSON. It never opens Story or Finding storage. Run it from a
Proof-or-Stop repository root with built local CLI assets. It selects an active
Story's required worktree when that worktree exists because `finding_list`
enforces the Story workspace boundary.

```bash
node <<'NODE'
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const execFileP = promisify(execFile);

(async () => {
  const node = process.execPath;
  const root = process.cwd();
  const cli = path.join(root, 'bin/proof-or-stop.js');
  const worktreeBase = path.basename(path.dirname(root)) === '.worktrees'
    ? path.dirname(root)
    : path.join(root, '.worktrees');
  const storyResult = JSON.parse(execFileSync(
    node, [cli, 'story_list', '--json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 },
  ));

  async function listFindings(story) {
    const worktree = path.join(worktreeBase, story.storyId);
    const cwd = fs.existsSync(worktree) ? worktree : root;
    const { stdout } = await execFileP(
      node, [cli, 'finding_list', `--storyId=${story.storyId}`, '--json'],
      { cwd, encoding: 'utf8', maxBuffer: 64e6 },
    );
    return { story, findings: JSON.parse(stdout).findings || [] };
  }

  const rows = [];
  for (let i = 0; i < storyResult.stories.length; i += 24) {
    rows.push(...await Promise.all(storyResult.stories.slice(i, i + 24).map(listFindings)));
  }
  const findings = rows.flatMap(({ story, findings }) =>
    findings.map(finding => ({ ...finding, _storyId: story.storyId, _phase: story.phase }))
  );
  const countBy = key => Object.fromEntries([...findings.reduce((map, row) => {
    const value = String(row[key] ?? 'missing');
    map.set(value, (map.get(value) || 0) + 1);
    return map;
  }, new Map())].sort((a, b) => b[1] - a[1]));
  const storyRows = rows.filter(row => row.findings.length > 0).map(row => ({
    storyId: row.story.storyId,
    phase: row.story.phase,
    count: row.findings.length,
    findingBoundReviewRuns: new Set(row.findings.map(f => f.reviewRunId).filter(Boolean)).size,
  }));
  const tagStories = new Map();
  for (const finding of findings) {
    if (!finding.signatureTag) continue;
    if (!tagStories.has(finding.signatureTag)) tagStories.set(finding.signatureTag, new Set());
    tagStories.get(finding.signatureTag).add(finding._storyId);
  }
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    storyCount: storyResult.stories.length,
    storyWithFindings: storyRows.length,
    findingCount: findings.length,
    status: countBy('status'),
    severity: countBy('severity'),
    evidenceState: countBy('evidenceState'),
    phase: countBy('_phase'),
    resolutionType: countBy('resolutionType'),
    resolveEvidenceStrength: countBy('resolveEvidenceStrength'),
    signatureTagSource: countBy('signatureTagSource'),
    filesPresent: findings.filter(f => Array.isArray(f.files) && f.files.length > 0).length,
    reviewRunIdPresent: findings.filter(f => f.reviewRunId).length,
    signatureTagPresent: findings.filter(f => f.signatureTag).length,
    uniqueSignatureTags: tagStories.size,
    crossStorySignatureTags: [...tagStories.values()].filter(stories => stories.size >= 2).length,
    topStories: storyRows.sort((a, b) => b.count - a.count).slice(0, 10),
  }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
NODE
```

Retrieve the named evidence without a storage shortcut:

```bash
proof-or-stop finding_list --storyId=B-cdf6 --json
proof-or-stop finding_list --storyId=B-META-framework-audit --json
proof-or-stop learning_validate --json
proof-or-stop learning_effectiveness --json
proof-or-stop signature_registry_list --json
proof-or-stop source_lineage_audit --domain=learning --json
```

An independent reviewer must check the exact IDs and outcomes named below. A
mismatched total, missing row, changed outcome, reversed supersession, or CLI
error invalidates the copied snapshot; it is not acceptable as illustrative
prose.

## 4. Seven historical failure classes

### P1. Review-volume and convergence cost

**Historical observation.** The point-in-time corpus contains Stories with 56
to 127 Finding rows, including B-f458, B-cc10, B-9ff1, B-cdf6, B-bf52, and
B-3434. B-cdf6:F-061, B-cdf6:F-062, and B-cdf6:F-065 are named sibling
examples: all are verified high findings in the same literal-comparison/parser
family, and B-cdf6:F-065 describes itself as the fourth sibling in the same
file/function family.
`docs/step3-review-budget-breaker-handoff.md` records a separate B-bf52 incident
where the deeper failure was taking many rounds to recognize an ill-posed task.

**Why the current model permits the cost.** A Finding is handled individually.
The current cluster implementation groups only by same severity and at least
50% effective-file overlap within one Story. It does not identify a semantic
root cause across files or Stories, and no batch applicability artifact can
disposition multiple members with one signed decision. Repeated genuine
Findings may therefore produce repeated reproduction, fix, resolution, and
review cycles.

**Desired invariant.** Detector candidates are grouped before promotion;
verified manifestations can reference one confirmed `canonicalDefectId`; a
single fix can trigger bounded re-verification of every member; and a signed
batch manifest can disposition multiple Findings without losing per-Finding
audit lineage. The existing convergence/stall adjudication remains the hard
backstop. The new system must not promise to eliminate genuine defects or their
repair time.

**Current-status caveat.** Counts show historical workload, not that the named
Stories are currently broken. The cited rows are resolved/DONE history. This
plan has not freshly reproduced their underlying defects at the documentation
HEAD.

### P2. Verified problem but not current-Story responsibility

**Historical observation.** B-cdf6:F-067 is `verified`, was recorded as a real
managed-asset ownership-predicate defect, and was resolved with
`resolutionType=superseded`. Its resolution states that it was pre-existing,
not caused by the rename, and was routed to B-META-framework-audit:F-034 rather
than fixed in B-cdf6.

**Why the current model permits the semantic mismatch.** There is no independent
applicability axis. `out_of_scope` exists only as an audit-only dismissal reason,
and `superseded` exists only as an audit-only resolution type. To unblock a
Story, an operator may have to terminalize a Finding even when the problem still
exists under another owner.

**Desired invariant.** Preserve `evidenceState=verified` and the original
Finding. Record a fresh `pre_existing_unaffected` assessment with base/head
evidence, proof that the target Story did not worsen the behavior, and a valid
route to B-META or another Story. The target Story may proceed; the canonical
owner retains the issue.

**Current-status caveat.** B-META-framework-audit:F-034 is historical routing
evidence. Its
presence does not prove the defect is currently unresolved, and the routing
record alone cannot unblock a new Story.

### P3. Detector-signal noise becomes review debt

**Historical observation.** B-cdf6:F-070 and its routed
B-META-framework-audit:F-035 record a `validate --concept` result of 14 deleted
symbols and 15,435 residual references. The reviewer reported zero genuine
dangling references; 15,326 matches, 99.3% of the total, came from the generic
word `main` matching branches, paths, and prose.

**Why the current model permits the cost.** A detector hit lacks a durable
pre-Finding candidate state. If noisy signals are treated as Findings or
gate-shaped output, reviewers inherit the burden of disproving them. Dynamic
applicability applied after promotion would merely automate cleaning up noise
that should never have become a Finding.

**Desired invariant.** `DetectorSignal` and `CandidateFinding` are explicitly
non-authoritative. Exact-boundary checks, deduplication, grouping, and current
reproduction occur before a reviewer/CLI promotion mints a verified Finding.
Zero verified defects means zero new Findings, regardless of raw match count.

**Current-status caveat.** The named record is a historical incident and does
not establish the present detector's false-positive rate. The future identity
Story must reproduce current detector behavior before claiming a fix.

### P4. Runtime-artifact freshness false positive

**Historical observation.** B-cdf6:F-056 was filed as a verified critical
failure after executing a temporarily broken `packages/main/dist` artifact.
The committed source at the reviewed HEAD contained the correct branch. The
Finding was resolved as `superseded`, with its resolution explicitly calling it
a false positive caused by a stale/transient build artifact. The systemic route,
B-META-framework-audit:F-032, explains that Git-based `headHash`, `materialHash`,
and `storyFilesHash` did not move because the executed `dist` output was ignored.

**Why the current model permits the failure.** Source freshness does not prove
that the bytes executed by a reviewer were built from that source. A signed
review run can remain source-fresh while mutable ignored artifacts change.

**Desired invariant.** Every gate-relevant execution against a mutable build
artifact produces a signed `RuntimeEvidenceReceipt` binding source HEAD, build
command/policy, artifact digests, command/output digests, timing, and exit
status. Artifact drift invalidates dependent applicability evidence. A build in
progress is a refusal, not a defect verdict.

**Current-status caveat.** B-META-framework-audit:F-032 records the historical
mechanism. It does not by itself prove that current build locks or receipt paths
remain insufficient; Story 3 must run a current stale-artifact/tamper campaign.

### P5. Incorrect historical statement and missing supersession chain

**Historical observation.** B-META-framework-audit:F-030 copied an approximate
brand-residue hit count into a durable Finding.
B-META-framework-audit:F-031 says the number was wrong, was produced by an
approximating regex, and drifted across HEADs. Because the Finding was
append-only and there was no update command, F-031 could only state in prose
that it superseded the count in F-030.

**Why the current model permits stale retrieval.** The current `Finding` shape
has an audit-only `resolutionType=superseded`, but no required, typed
`supersedesFindingId`, canonical-current-record pointer, acyclic-chain check, or
query rule that suppresses a superseded assertion. A recall consumer can return
F-030 without F-031.

**Desired invariant.** Historical rows remain append-only. A signed
`FindingSupersession` links predecessor, successor, reason, source hashes, and
effective time. Canonical lookup resolves the acyclic chain and returns the
current record while preserving the complete history. Volatile measurements
are reproduced by commands at the current HEAD instead of copied as durable
constants.

**Current-status caveat.** The pair proves a historical correction failure.
The figures inside those descriptions are intentionally not reused here, and
their open status does not prove a current brand-residue count.

### P6. Concurrent ledger write loss and ID reuse

**Historical observation.** B-META-framework-audit:F-029 records two concurrent
reviewer `finding_add` calls against B-cdf6. Its Git-backed incident sequence
shows a Finding count decreasing, a row disappearing, and an F-number later
being reused for a different lane. The record classifies the loss as critical
because a verified blocker could disappear silently.

**Why the historical model permitted the failure.** The recorded implementation
used non-atomic read-modify-write and derived the next ID from a mutable array
shape. Successful callers had no durable idempotency/commit receipt proving
their exact row survived.

**Desired invariant.** Finding and assessment mutations use one per-Story
atomic transaction primitive, collision-resistant monotonic/unique IDs,
idempotency keys, expected-prior digest or equivalent compare-and-swap,
write-after-read verification, and an append-only ledger receipt. Retry returns
the original result; it does not create another row.

**Current-status caveat.** Current `packages/main/src/handlers/finding.ts`
contains a per-Story Finding critical section around read/push/write. Therefore
this plan does not claim that F-029's exact race remains reproducible. Story 3
must test the current Finding, review-run, assessment, manifest, and receipt
paths concurrently rather than assuming either failure or safety.

### P7. Weak/coarse historical recall

**Current point-in-time observation.** At the documentation HEAD:

- `learning_effectiveness --json` returned 367 Stories, 2,239 Findings with a
  signature, 594 pre-warnable Findings, and recall
  `0.2652970075926753` (about 26.53%). Its experiment arms were both empty, so
  it reported no statistically supported treatment effect.
- `learning_validate --json` returned 1,458 signals, 1,228 anchored,
  1,180 valid, 48 stale, and 230 unanchored. Its coverage object reported
  `known=false`, zero covered Findings against 2,273 current Findings, and zero
  covered Stories against 210 current Stories. That means this cache cannot be
  presented as complete corpus coverage.
- `signature_registry_list --json` reported no registered tags.
- The CLI-derived Finding projection contained 1,431 tag strings, only 67 used
  by at least two Stories; 2,022 were auto and 217 confirmed.
- `source_lineage_audit --domain=learning --json` returned 2,618 source records,
  2 missing-lineage records, zero duplicate canonical-source groups,
  `authority=non_authoritative`, and `gateEvidence=false` at
  `2026-08-30T22:47:32.966Z`.

**Why the current model permits weak recall.** `story-recall.ts` is an ad-hoc
scan using structured Jaccard over keywords, file kinds, and touchpoints. Coarse
auto tags are candidates rather than confirmed semantic identities, and no
registered canonical defect vocabulary connects sibling manifestations.

**Desired invariant.** Historical lookup uses confirmed canonical defect IDs,
source lineage, affected symbols/contracts, trigger conditions, and
supersession-aware current-record selection. Recall metrics are measured by a
versioned gold set. Historical matches remain candidates and are revalidated on
the current material before any gate-consumed record is minted.

**Current-status caveat.** These are current CLI projections of learning quality,
not proof that any recalled defect remains active. Better recall also cannot be
claimed until a labeled benchmark shows it.

### 4.1 Why one applicability field cannot cover all seven

P2 is the direct applicability problem. P1 is mitigated when routing and batch
disposition remove unnecessary work. P3 requires a candidate boundary before a
Finding exists. P4 requires runtime evidence outside Git. P5 requires explicit
historical lineage. P6 is storage integrity. P7 requires semantic identity and
measured retrieval. Collapsing these into `related=true|false` would hide
different authorities, freshness rules, and failure modes behind one unsafe
bit.

## 5. Four-component architecture

There are exactly four components. Each has one authority boundary and explicit
non-responsibilities.

### 5.1 Finding Ledger Integrity

| Contract | Definition |
| --- | --- |
| Inputs | Proposed Finding, candidate route, assessment, mandatory-repair classification/closure, deferral, progress baseline set, material-drift re-attestation, supersession, manifest, `FindingRouteReceipt`, and ledger-receipt mutations; actor/session; idempotency key; expected prior digest; exact referenced-record ID/hash CAS bindings |
| Records | Immutable ledger entries, unique IDs, transaction/commit digest, persisted signed `FindingRouteReceipt`, `FindingLedgerReceipt`, lock/lease diagnostics |
| Authority | Authoritative only for persistence integrity: whether exact bytes were durably committed once. It does not attest that the content is true. |
| Outputs | Exactly-once append result, durable ID, previous/new ledger digest, replay result, explicit conflict/refusal, signed read-only ledger/CAS/runtime scorecard query rows |
| Non-responsibilities | Detector precision, semantic equivalence, severity, applicability, routing judgment, or freshness interpretation |

Every Finding-system mutation named above, including a non-authoritative
candidate route, must use this shared primitive. No new manifest writer may
bypass it. The primitive must compose with existing per-Story locks and
main/B-META write coordination without nested-lock deadlock. It permits Story 2
to commit a standalone signed route receipt atomically. In a later, separate
transaction it permits Story 1 to lock and read the latest receipt-chain bytes,
run its semantic verifier, compare exact expected references, and atomically
commit a deferral plus manifest/action. Story 3 supplies transaction isolation,
CAS, and persistence only; it neither signs route semantics nor imports Story 1.

Candidate and canonical-defect records are immutable version/events, never
mutable state or member arrays. A changed candidate disposition or canonical
membership appends a successor with `previousVersionHash`; readers derive a
signed current projection. `FindingSupersession` links immutable `FindingRef`s,
so human display IDs remain compatible while global `recordId`s prevent aliasing.
Ledger receipts cover only actual transaction commits (Finding, candidate,
candidate route, assessment, canonical defect, supersession, route, runtime
receipt, manifest and related mutation records); they are system metadata and
never recursively receipt themselves.

### 5.2 Candidate and Defect Identity

| Contract | Definition |
| --- | --- |
| Inputs | Detector outputs, reviewer suspicions, current source anchors, Finding history through the stable accessor/CLI port, source-lineage records, supersession-aware historical rows |
| Records | `DetectorSignal`, `CandidateFinding`, non-authoritative `CandidateRoute`, base `FindingRouteReceipt`, target-authorized `InitialProgressBaselineSet`, typed `ProgressEvidenceBinding`/`ProgressProjection` contracts, `CanonicalDefect`, `CanonicalDefectSupersession`, derived historical index, candidate-to-Finding promotion receipt |
| Authority | Signals, candidates, auto signatures, recall hits, and the index are advisory. This component may mint/verify target-side acceptance for candidate or Finding-assessment subjects, but every receipt remains `gateEvidence=false`. A designated reviewer plus CLI may confirm identity or promote a currently verified Finding; historical identity alone has no gate authority. |
| Outputs | Deduped/grouped candidates, evidence-bearing suspected routes, canonical defect suggestions/confirmations, ranked historical candidates, affected symbols/contracts, current canonical historical row, trigger-matched recall candidates, and signed read-only identity/route/progress scorecard query rows |
| Non-responsibilities | Current-Story applicability, lifecycle blocking, runtime artifact freshness, durable-write correctness, or fixing detector implementation quality |

Source-lineage identity and semantic defect identity are separate fields.
Several derived records may share one canonical source without describing the
same defect, and several independent sources may describe one semantic defect.
Canonical identity also does not require a known root cause: a stable trigger,
reproduction shape, and affected contract may establish identity while the cause
is still unknown or hypothesized. Later correction is append-only supersession,
not an in-place invented cause.

### 5.3 Dynamic Applicability

| Contract | Definition |
| --- | --- |
| Inputs | One verified/open Finding, target Story, signed scope contract/digest, base/head evidence, current diff/touchpoints, protected-surface risk classification, canonical owner, routing candidates, review run, freshness verdicts |
| Records | Signed `FindingApplicabilityAssessment`, verifier-derived signed `AssessmentIntegrityState`, `MandatoryRepairClassification`, ledger-derived `DeferralLineageState`, gate-consumed `MaterialDriftReattestation`, Story 1's exact receipt/baseline CAS L4 profile over Story 2's `FindingRouteReceipt`, `FindingDeferralDisposition`, versioned `DeferralExpiryPolicy`, signed batch disposition manifest, read-only rollout scorecard, reviewer override/adjudication with reason |
| Authority | Advisory in observe/warn. In enforce, only the designated CLI writer plus eligible current reviewer may mint signed L4 assessments/dispositions; the registered verifier derives signed `AssessmentIntegrityState` and `DeferralLineageState` directly for the shared predicate. |
| Outputs | `applicable`, `pre_existing_unaffected`, `out_of_scope`, `duplicate`, `not_reproduced_under_current_witness`, or `unknown`; a transient pre-round assessment-integrity floor for verified open high/critical Findings whose required assessment is missing or invalid; a distinct mandatory-repair floor for applicable high/critical, protected-surface risk, or ledger-derived invalid claimed lineage; optional defer-with-proof after eligible low/medium; exact-CAS consumption of Story 2 target acceptance/revocation; checked-in scorecard JSON/refusal; evidence references; gate projection |
| Non-responsibilities | Changing Finding truth/severity/status, declaring semantic identity from similarity, proving bytes were stored, producing runtime receipts, or deleting the underlying issue |

Applicability is target-specific and expiring. A Finding may be applicable to
Story A, pre-existing for Story B, and duplicate of a canonical owner in Story C.
An applicable Finding is not automatically deferrable: the separate disposition
must prove the narrow policy below and must never rewrite the applicability
verdict.

### 5.4 Freshness and Supersession

| Contract | Definition |
| --- | --- |
| Inputs | Ledger/canonical-chain claim scan; candidate-route/assessment/mandatory-repair/route-receipt/deferral signatures and bindings; canonical-defect/deferral lineage; `DeferralExpiryPolicy`; current `headHash`, `materialHash`, `storyFilesHash`, scope digest and runtime receipts; predecessor/successor Finding records; route-owner/lease/policy state; source hashes; clock |
| Records | `RuntimeEvidenceReceipt`, `FindingSupersession`, route-receipt revocation/freshness, mandatory-repair closure freshness, signed `DeferralLineageState`, gate-consumed `MaterialDriftReattestation`, candidate-route/deferral expiry evaluation, canonical-current-record projection |
| Authority | Runtime receipts and signed assessment freshness are authoritative only for the evidence they bind. Supersession is authoritative for historical record selection after signature/chain validation. Historical content remains non-authoritative for a new Story until revalidated. |
| Outputs | fresh, pending re-attestation, unrelated-and-re-attested, stale, expired, tampered, missing, unknown; canonical current historical record; exact invalidation/reopen reason |
| Non-responsibilities | Deciding whether a detector hit is a defect, whether two sources are semantically equivalent, assigning severity, or persisting records without the ledger component |

This component is intentionally delivered across two prerequisite Stories and
the applicability consumer: Story 2 owns historical supersession/canonical
lookup plus candidate-route receipt freshness; Story 3 owns runtime receipts and
artifact invalidation; Story 1 binds source/scope/runtime and cumulative
deferral-lineage freshness into assessments and the gate.

`RuntimeEvidenceReceipt` is content-addressed: canonicalized build and execution
commands, stdout/stderr, an allowlisted and redacted environment projection, and
the artifact manifest each retain both digest and immutable `EvidenceBlobRef`.
Its policy fixes command canonicalization, environment exclusions/secret
redaction, compiler/runtime/toolchain versions, symlink/realpath treatment, and
producer key ID/algorithm/trust root with rotation/revocation/freshness checks.
It proves only that declared source/material produced the recorded bytes; it
does not prove semantic correctness.

### 5.5 End-to-end flow

```text
detector/reviewer observation
  -> DetectorSignal                         [advisory; never gate]
  -> CandidateFinding                       [advisory; dedup/group/reproduce]
  -> optional CandidateRoute                [suspected low/medium; advisory;
                                              existing owner + Story 2 receipt]
  -> later recall as CandidateFinding only
  -> or reviewer + CLI current verification
  -> existing Finding(evidenceState=verified)
  -> CanonicalDefect link                    [identity; historical hint only]
  -> target-Story base/head/scope/owner analysis
  -> RuntimeEvidenceReceipt where execution uses mutable artifacts
  -> FindingApplicabilityAssessment          [signed, current, L4 in enforce]
  -> AssessmentIntegrityState                [derived pre-round floor for an
                                               invalid required high/critical
                                               assessment; no repair claim]
  -> MandatoryRepairClassification           [applicable high/critical or
                                                protected/lineage risk; L4 floor]
  -> Red/repro -> root cause -> fix -> Green  [mandatory floor closure]
  -> or Story 2 FindingRouteReceipt +         [initial route atomically binds
       InitialProgressBaselineSet              four signed baselines; non-gate]
  -> Story 1 exact receipt/baseline CAS       [latest ID/hash/profile/source]
  -> FindingDeferralDisposition + manifest   [one atomic CAS commit;
                                               applicable low/medium only; L4]
  -> DeferralLineageState                     [ledger/canonical derived first;
                                               assessment cannot erase claim]
  -> one shared blocking predicate
  -> REVIEW/TEST/DONE consumers

historical Finding
  -> source-lineage dedup
  -> supersession-chain resolution
  -> current canonical historical record
  -> CandidateFinding only
  -> current verification required before assessment/gate
```

The order is important. DetectorSignal, CandidateFinding, signature tag,
playbook, recall hit, file-disjoint heuristic, and DONE outcome can neither block
nor unblock REVIEW, TEST, or DONE.

## 6. Data model sketches

These are future contract sketches, not implemented TypeScript.

```ts
type AdvisoryAuthority = {
  authority: 'non_authoritative';
  gateEvidence: false;
};

/** `findingId` is the stable human Story-local display ID; `recordId` is the
 * immutable globally unique ledger identity used by every signed reference. */
interface FindingRef {
  storyId: string;
  findingId: string;
  recordId: string;
}

interface EvidenceBlobRef {
  blobId: string;
  contentDigest: string;
  contentType: 'command' | 'stdout' | 'stderr' | 'environment' | 'artifact_manifest';
  redactionPolicyDigest: string;
}

interface DetectorSignal extends AdvisoryAuthority {
  schemaVersion: 1;
  signalId: string;
  detectorId: string;
  detectorVersion: string;
  observedAt: string;
  targetStoryId: string;
  headHash: string;
  command?: string;
  outputDigest: string;
  matchCount: number;
  anchors: Array<{ path: string; line?: number; symbol?: string }>;
  rawCategory: string;
}

interface CandidateFinding extends AdvisoryAuthority {
  schemaVersion: 1;
  candidateId: string;
  targetStoryId: string;
  sourceSignalIds: string[];
  suspectedDefect: string;
  affectedSymbols: string[];
  affectedContracts: string[];
  candidateGroupKey: string;
  state: 'pending_verification' | 'promoted' | 'disproven' | 'merged';
  previousVersionHash?: string;
  currentProjectionHash: string;
  currentEvidenceRefs: string[];
  canonicalDefectCandidateId?: string;
  promotionFindingRef?: FindingRef;
  candidateRouteId?: string;
}

interface CandidateRoute extends AdvisoryAuthority {
  schemaVersion: 1;
  candidateRouteId: string;
  candidateId: string;
  storyId: string;
  severity: 'low' | 'medium';
  reasonCode: 'suspected_follow_up_story' | 'suspected_meta_gap';
  uncertaintyReason: string;
  evidenceRefs: string[];
  target: {
    kind: 'existing_story' | 'b_meta_gap';
    id: string;
    owner: string;
    routeReceiptId: string;
    routeReceiptHash: string;
    routeReceiptProfile: 'candidate_route';
    routeReceiptSourceCandidateHash: string;
  };
  scopeDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  runtimeReceiptIds: string[];
  affectedContractRefs: string[];
  recheckTriggers: FindingRecheckTrigger[];
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  candidateRouteHash: string;
  signature: string;
}

type RouteAcceptanceAuthority =
  | 'target_story_owner'
  | 'target_command_policy_actor'
  | 'b_meta_canonical_audit'
  | 'main_write_authority';

interface FindingRouteReceipt {
  schemaVersion: 1;
  routeReceiptId: string;
  evidenceAuthority: {
    profile: 'candidate_route' | 'finding_route';
    authority: 'target_route_semantic_only';
    gateEvidence: false;
  };
  source: {
    subjectKind: 'candidate_finding' | 'finding_assessment_proposal';
    subjectId: string;
    subjectHash: string; // candidate hash or immutable proposalDigest
    storyId: string;
  };
  target: {
    kind: 'existing_story' | 'b_meta_gap';
    id: string;
    state:
      | 'planned'
      | 'active'
      | 'done'
      | 'discarded'
      | 'audit_open'
      | 'audit_closed';
    scopeDigest: string;
    targetResponsibilityRef: FindingRef | { workItemRef: string; workItemHash: string };
  };
  owner: {
    identity: string;
    authority: RouteAcceptanceAuthority;
    leaseId?: string;
    authorityPolicyVersion: string;
  };
  decision: 'accepted' | 'rejected';
  acceptedAt?: string;
  rejectedAt?: string;
  expiresAt: string;
  revokedAt?: string;
  revocationReason?:
    | 'owner_changed'
    | 'target_closed_unfixed'
    | 'target_scope_changed'
    | 'authority_policy_changed'
    | 'target_rejected';
  routeChainDigest: string;
  visitedTargetDigests: string[];
  supersedesRouteReceiptId?: string;
  routeSubjectDigest: string;
  initialProgressBaselineSet?: {
    baselineSetId: string;
    baselineSetHash: string;
  };
  progressEvidence?: ProgressEvidenceBinding;
  policyDigest: string;
  signedBy: string;
  signedByAuthority: RouteAcceptanceAuthority;
  receiptHash: string;
  signature: string;
}

type ProgressEvidenceKind =
  | 'target_source_change'
  | 'target_test_result'
  | 'target_delivery_state'
  | 'target_status_transition';

type ProgressProjection =
  | {
      kind: 'target_source_change';
      affectedContractRef: string;
      affectedSourceRefs: string[];
      relevantSourceDigest: string;
    }
  | {
      kind: 'target_test_result';
      defectBoundCommandDigest: string;
      selectorDigest: string;
      outcome: 'pass' | 'fail';
      executionReceiptId: string;
      executionReceiptHash: string;
    }
  | {
      kind: 'target_delivery_state';
      subjectKind: 'acceptance_item' | 'checklist_item';
      subjectRef: string;
      signedState: string;
      stateEvidenceId: string;
      stateEvidenceHash: string;
    }
  | {
      kind: 'target_status_transition';
      defectWorkItemRef: string;
      fromState: string;
      toState: string;
      transitionPolicyDigest: string;
      processReceiptId: string;
      processReceiptHash: string;
    };

interface InitialProgressBaseline {
  schemaVersion: 1;
  evidenceAuthority: {
    profile: 'progress_baseline';
    authority: 'target_route_semantic_only';
    gateEvidence: false;
  };
  kind: ProgressEvidenceKind;
  canonicalDefectId: string;
  routeReceiptId: string;
  routeSubjectDigest: string;
  subject: {
    affectedContractRefs: string[];
    targetAcceptanceRefs: string[];
    targetChecklistItemRefs: string[];
    commandOrWorkItemRefs: string[];
  };
  projectionState: 'present' | 'absent';
  projection?: ProgressProjection;
  projectionDigest?: string;
  absenceDigest?: string;
  capturedAt: string;
  targetSnapshot: {
    kind: 'existing_story' | 'b_meta_gap';
    id: string;
    scopeDigest: string;
    headHash: string;
    materialHash: string;
    storyFilesHash?: string;
  };
  derivedBy: {
    producer: 'cli' | 'server';
    producerVersion: string;
    commandOrHandlerDigest: string;
  };
  signedBy: string;
  signedByAuthority: RouteAcceptanceAuthority;
  baselineHash: string;
  signature: string;
}

interface InitialProgressBaselineSet {
  schemaVersion: 1;
  evidenceAuthority: {
    profile: 'progress_baseline';
    authority: 'target_route_semantic_only';
    gateEvidence: false;
  };
  baselineSetId: string;
  canonicalDefectId: string;
  routeReceiptId: string;
  routeSubjectDigest: string;
  targetKind: 'existing_story' | 'b_meta_gap';
  targetId: string;
  baselines: [
    InitialProgressBaseline,
    InitialProgressBaseline,
    InitialProgressBaseline,
    InitialProgressBaseline
  ];
  capturedAt: string;
  derivedByProducer: 'cli' | 'server';
  signedBy: string;
  signedByAuthority: RouteAcceptanceAuthority;
  baselineSetHash: string;
  signature: string;
}

interface ProgressEvidenceBinding {
  schemaVersion: 1;
  kind: ProgressEvidenceKind;
  evidence: {
    evidenceId: string;
    evidenceHash: string;
    evidenceSignature: string;
    producedAt: string;
  };
  targetSnapshot: {
    kind: 'existing_story' | 'b_meta_gap';
    id: string;
    scopeDigest: string;
    headHash: string;
    materialHash: string;
    storyFilesHash?: string;
  };
  subject: {
    canonicalDefectId: string;
    routeReceiptId: string;
    routeSubjectDigest: string;
    affectedContractRefs: string[];
    targetAcceptanceRefs: string[];
    targetChecklistItemRefs: string[];
  };
  projection: ProgressProjection;
  projectionDigest: string;
  predecessorProjectionDigest: string;
  previousDeferralId: string;
  predecessorBaselineDigest: string;
  tupleDigest: string;
  signedBy: string;
  signedByAuthority: RouteAcceptanceAuthority;
  signature: string;
}

interface CanonicalDefect extends AdvisoryAuthority {
  schemaVersion: 1;
  canonicalDefectId: string;
  title: string;
  triggerCondition: string;
  rootCauseState: 'unknown' | 'hypothesized' | 'confirmed';
  rootCause?: string;
  identityEvidenceRefs: string[];
  affectedSymbols: string[];
  affectedContracts: string[];
  memberFindingRefs: FindingRef[];
  canonicalFindingRef: FindingRef;
  identityState: 'suggested' | 'reviewer_confirmed' | 'superseded';
  confirmedBy?: string;
  confirmedAt?: string;
  sourceLineageKeys: string[];
  identityDigest: string;
  previousVersionHash?: string;
  currentProjectionHash: string;
}

interface CanonicalDefectSupersession extends AdvisoryAuthority {
  schemaVersion: 1;
  canonicalSupersessionId: string;
  predecessorCanonicalDefectId: string;
  successorCanonicalDefectId: string;
  reason: 'root_cause_corrected' | 'identity_split' | 'identity_merged';
  evidenceRefs: string[];
  predecessorHash: string;
  successorHash: string;
  effectiveAt: string;
  recordHash: string;
  signature: string;
}

type AssessmentFreshness =
  | 'fresh'
  | 're_attestation_required'
  | 'stale'
  | 'tampered'
  | 'missing'
  | 'expired';

interface FindingAssessmentProposalEnvelope {
  schemaVersion: 1;
  proposalId: string;
  findingRef: FindingRef;
  findingHash: string;
  findingVersion: string;
  evaluationScope: 'target_story' | 'canonical_owner' | 'repository_release';
  owner: 'current_story' | 'meta' | 'other_story' | 'unowned';
  issuedAt: string;
  expiresAt: string;
  freshnessPolicyVersion: string;
  maxAgeSeconds: number;
  dependencyBundle: {
    digest: string;
    sourceFinding: FindingRef & { hash: string; version: string };
    canonicalIdentityDigest?: string;
    currentCanonicalFinding?: FindingRef & { hash: string };
    supersessionChainTipDigest?: string;
    proofPolicyDigest: string;
    reviewerAuthorityPolicyDigest: string;
    ledgerSnapshotDigest: string;
  };
  evidenceRefs: string[];
  historicalSourceRefs: Array<FindingRef & { sourceFindingHash: string; canonicalSourceKey?: string }>;
  protectedSurfaceEvaluation: Array<{
    surface: DeferredProtectedSurface;
    state: 'clear' | 'known_risk' | 'unknown';
    evidenceRefs: string[];
  }>;
  reviewRunId: string;
  reviewRound: string;
  scopeDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  runtimeReceiptIds: string[];
  assessedBy: string;
  proposalDigest: string;
  proposalSigner: {
    actorId: string;
    authorityDigest: string;
    keyId: string;
    algorithm: string;
    trustRootDigest: string;
  };
  proposalSignature: string;
}

type FindingAssessmentProposal =
  | (FindingAssessmentProposalEnvelope & { verdict: 'applicable'; basis: 'introduced_by_diff' | 'direct_scope'; owner: 'current_story'; currentWitness: { receiptIds: string[]; reproduced: true } })
  | (FindingAssessmentProposalEnvelope & { verdict: 'pre_existing_unaffected'; basis: 'base_head_reproduction'; owner: 'meta' | 'other_story'; baseHead: { baseRef: string; baseResult: 'reproduced'; headRef: string; headResult: 'reproduced'; worsenedByStory: false; receiptIds: string[] } })
  | (FindingAssessmentProposalEnvelope & { verdict: 'out_of_scope'; basis: 'decision_scope'; owner: 'meta' | 'other_story'; excludedScopeProofDigest: string })
  | (FindingAssessmentProposalEnvelope & { verdict: 'duplicate'; basis: 'canonical_duplicate'; owner: 'meta' | 'other_story'; canonicalDefectRef: { canonicalDefectId: string; identityDigest: string; currentCanonicalFinding: FindingRef & { hash: string }; canonicalOwner: string } })
  | (FindingAssessmentProposalEnvelope & { verdict: 'not_reproduced_under_current_witness'; basis: 'counter_evidence'; owner: 'meta' | 'other_story'; currentWitness: { receiptIds: string[]; reproduced: false; commandPolicyDigest: string; runtimeEvidenceDigest: string; negativeWitnessDigest: string } })
  | (FindingAssessmentProposalEnvelope & { verdict: 'unknown'; basis: 'direct_scope' | 'counter_evidence'; nonBlockingProof?: never });

interface AssessmentEnvelope {
  schemaVersion: 1;
  assessmentId: string;
  proposalId: string;
  assessmentProposalDigest: string;
  proposalReceipt: {
    receiptId: string;
    receiptHash: string;
    operation: 'append_assessment_proposal';
  };
  acceptedRoute?: {
    receiptId: string;
    receiptHash: string;
    profile: 'finding_route';
    sourceAssessmentProposalId: string;
    sourceAssessmentProposalDigest: string;
    targetResponsibilityRef: FindingRef | { workItemRef: string; workItemHash: string };
    routeChainDigest: string;
  };
  assessmentHash: string;
  signature: string;
}

type AssessmentRouteBinding =
  | { verdict: 'applicable'; dispositionPlan: 'repair_current'; acceptedRoute?: never }
  | { verdict: 'applicable'; dispositionPlan: 'defer_with_proof'; acceptedRoute: NonNullable<AssessmentEnvelope['acceptedRoute']> }
  | { verdict: 'unknown'; dispositionPlan?: never; acceptedRoute?: never }
  | { verdict: 'pre_existing_unaffected' | 'out_of_scope' | 'duplicate' | 'not_reproduced_under_current_witness'; dispositionPlan?: never; acceptedRoute: NonNullable<AssessmentEnvelope['acceptedRoute']> };

type FindingApplicabilityAssessment = FindingAssessmentProposal & AssessmentEnvelope & AssessmentRouteBinding;

type DeferredProtectedSurface =
  | 'data_integrity'
  | 'security_or_privacy'
  | 'package_publish_or_clean_install'
  | 'cli_primary_entrypoint'
  | 'agent_resolution'
  | 'historical_evidence_integrity'
  | 'lifecycle_gate';

type FindingRecheckTrigger =
  | 'target_story_or_gap_started'
  | 'scope_changed'
  | 'material_or_story_files_changed'
  | 'runtime_binding_changed'
  | 'affected_contract_matched'
  | 'severity_escalated'
  | 'owner_invalid'
  | 'target_closed_unfixed'
  | 'expiry_reached';

type RequiredAssessmentInvalidState =
  | 'missing'
  | 're_attestation_required'
  | 'stale'
  | 'unsigned'
  | 'tampered'
  | 'mismatched'
  | 'incomplete'
  | 'expired'
  | 'unknown';

interface AssessmentIntegrityState {
  schemaVersion: 1;
  findingRef: FindingRef;
  state:
    | 'blocking_invalid'
    | 'released_strong_non_applicable'
    | 'converted_to_mandatory_repair'
    | 'not_required';
  invalidState?: RequiredAssessmentInvalidState;
  freshness: AssessmentFreshness;
  assessmentId?: string;
  assessmentHash?: string;
  assessmentDependencyBundleDigest?: string;
  independentProofDigest?: string;
  mandatoryRepairId?: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  scopeDigest: string;
  runtimeEvidenceDigest: string;
  processPolicyDigest: string;
  derivedAt: string;
  verifierId: string;
  stateHash: string;
  signature: string;
}

interface MandatoryRepairClassification {
  schemaVersion: 1;
  mandatoryRepairId: string;
  findingRef: FindingRef;
  findingHash: string;
  findingVersion: string;
  assessmentId: string;
  state: 'required' | 'closure_proven';
  reasons: Array<
    | 'critical_or_high'
    | 'protected_surface_known_risk'
    | 'protected_surface_unknown_risk'
    | 'deferral_lineage_missing'
    | 'deferral_lineage_stale'
    | 'deferral_lineage_expired'
    | 'deferral_lineage_exhausted'
    | 'deferral_lineage_tampered'
    | 'deferral_lineage_unknown'
  >;
  severityAtClassification: 'critical' | 'high' | 'medium' | 'low';
  protectedSurfaceRisks: Array<{
    surface: DeferredProtectedSurface;
    state: 'known' | 'unknown';
    evidenceRefs: string[];
  }>;
  classificationEvidenceRefs: string[];
  closure?: {
    redOrReproductionEvidenceRefs: string[];
    rootCauseEvidenceRefs: string[];
    fixEvidenceRefs: string[];
    greenEvidenceRefs: string[];
    closureEvidenceRefs: string[];
  };
  supersedesMandatoryRepairId?: string;
  reviewRunId: string;
  scopeDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  runtimeReceiptIds: string[];
  policyDigest: string;
  classifiedBy: string;
  classifiedAt: string;
  classificationHash: string;
  signature: string;
}

interface DeferralExpiryPolicy {
  schemaVersion: 1;
  policyVersion: 'v1';
  cumulativeHorizonSeconds: {
    medium: 604800; // 7 * 24 hours
    low: 2592000; // 30 * 24 hours
  };
  maxRenewalCount: {
    medium: 0;
    low: 1;
  };
  hardCeilingSeconds: 2592000;
  effectiveAt: string;
  supersedesPolicyDigest?: string;
  policyDigest: string;
  signedBy: string;
  signedByAuthority: 'command_policy_authority';
  signature: string;
}

type DeferralLineageValidity =
  | 'not_present'
  | 'valid'
  | 'missing'
  | 'stale'
  | 'pending_re_attestation'
  | 'expired'
  | 'exhausted'
  | 'tampered'
  | 'unknown'
  | 'released';

type DeferralLineageReasonCode =
  | 'no_committed_disposition'
  | 'deferral_manifest_partial'
  | 'replacement_assessment_missing'
  | 'replacement_assessment_stale'
  | 'replacement_assessment_tampered'
  | 'replacement_assessment_omits_claim'
  | 'scope_digest_drift'
  | 'story_files_hash_drift'
  | 'material_hash_drift'
  | 'runtime_binding_drift'
  | 'material_re_attestation_missing'
  | 'material_re_attestation_stale'
  | 'material_re_attestation_tampered'
  | 'material_re_attestation_related_change'
  | 'material_re_attestation_unknown_dependency'
  | 'route_receipt_not_latest'
  | 'route_receipt_invalid'
  | 'expiry_boundary_reached'
  | 'cumulative_horizon_reached'
  | 'renewal_count_exhausted'
  | 'lineage_digest_invalid'
  | 'trusted_clock_unknown';

interface DeferralLineageRelease {
  kind:
    | 'pre_existing_unaffected'
    | 'out_of_scope'
    | 'duplicate'
    | 'disproven'
    | 'repair_closure';
  sourceArtifactId: string;
  sourceArtifactHash: string;
  proofContractDigest: string;
  evidenceRefs: string[];
  verifiedAt: string;
}

interface MaterialDriftReattestation {
  schemaVersion: 1;
  reattestationId: string;
  findingRef: FindingRef;
  findingHash: string;
  findingVersion: string;
  canonicalDefectId: string;
  deferralId: string;
  priorMaterialHash: string;
  currentMaterialHash: string;
  storyFiles: {
    priorHash: string;
    currentHash: string;
    unchanged: true;
  };
  dependencyBindings: {
    runtimeReceipts: Array<{
      receiptId: string;
      priorDigest: string;
      currentDigest: string;
      comparison: 'unaffected' | 'changed' | 'unknown';
    }>;
    processPolicy: {
      priorDigest: string;
      currentDigest: string;
      comparison: 'unaffected' | 'changed' | 'unknown';
    };
    routeReceipt: {
      routeReceiptId: string;
      priorHash: string;
      currentHash: string;
      comparison: 'unaffected' | 'changed' | 'unknown';
    };
    canonicalDependencies: Array<{
      dependencyId: string;
      priorDigest: string;
      currentDigest: string;
      comparison: 'unaffected' | 'changed' | 'unknown';
    }>;
  };
  verdict: 'unrelated' | 'related' | 'unknown';
  evidenceRefs: string[];
  gateEvidence: true;
  processFactLevel: 'L4';
  assessedAt: string;
  assessedBy: string;
  assessedByAuthority: 'current_reviewer' | 'command_policy_authority';
  reattestationHash: string;
  signature: string;
}

interface DeferralLineageState {
  schemaVersion: 1;
  findingRef: FindingRef;
  findingHash: string;
  findingVersion: string;
  assessmentId?: string;
  canonicalDefectId: string;
  hasHistoricalClaim: boolean;
  claimDeferralIds: string[];
  claimLedgerDigest: string;
  claimCanonicalChainDigest: string;
  replacementAssessmentState:
    | 'not_required'
    | 'fresh_bound'
    | 'missing'
    | 'stale'
    | 'tampered'
    | 'omits_prior_lineage';
  materialDriftState:
    | 'none'
    | 'pending_re_attestation'
    | 'unrelated_re_attested'
    | 'related'
    | 'unknown';
  validity: DeferralLineageValidity;
  boundary: 'before' | 'exact' | 'after' | 'unknown';
  activeDeferralId?: string;
  activeDispositionHash?: string;
  latestRouteReceiptId?: string;
  latestRouteReceiptHash?: string;
  materialDriftReattestationId?: string;
  materialDriftReattestationHash?: string;
  lineageDigest?: string;
  release?: DeferralLineageRelease;
  reasonCodes: DeferralLineageReasonCode[];
  evaluatedAt: string;
  trustedClockDigest: string;
  verifierId: string;
  verifierVersion: string;
  verifierDigest: string;
  signature: string;
}

interface FindingDeferralDisposition {
  schemaVersion: 1;
  deferralId: string;
  findingRef: FindingRef;
  findingHash: string;
  findingVersion: string;
  assessmentId: string;
  assessmentHash: string;
  assessmentProposalId: string;
  assessmentProposalDigest: string;
  assessmentDispositionPlan: 'defer_with_proof';
  canonicalDefectId: string;
  lineageCanonicalDefectIds: string[];
  lineageRootDeferralId: string;
  firstDeferredAt: string;
  renewalCount: number;
  observedSeverities: Array<'critical' | 'high' | 'medium' | 'low'>;
  cumulativeHorizonEndsAt: string;
  lineageDigest: string;
  reasonCode:
    | 'existing_follow_up_story'
    | 'existing_meta_gap'
    | 'bounded_non_acceptance_work';
  acceptanceImpact: {
    direct: false;
    acceptanceRefs: string[];
    verificationIntentRefs: string[];
    analysisEvidenceRefs: string[];
  };
  introducedByCurrentStory: false;
  protectedSurfaceImpact: {
    affected: false;
    evaluatedSurfaces: DeferredProtectedSurface[];
    evidenceRefs: string[];
  };
  target: {
    kind: 'existing_story' | 'b_meta_gap';
    id: string;
    owner: string;
    routeReceiptId: string;
    routeReceiptHash: string;
    routeReceiptProfile: 'finding_route';
    routeReceiptSourceAssessmentProposalId: string;
    routeReceiptSourceAssessmentProposalDigest: string;
    targetSnapshotDigest: string;
  };
  initialProgressBaselineSetId: string;
  initialProgressBaselineSetHash: string;
  currentRedEvidenceRefs: string[];
  rootCauseEvidenceRefs?: string[];
  reviewRunId: string;
  scopeDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  runtimeReceiptIds: string[];
  affectedContractRefs: string[];
  recheckTriggers: FindingRecheckTrigger[];
  expiryPolicyVersion: 'v1';
  policyDigest: string;
  expiresAt: string;
  supersedesDeferralId?: string;
  progressEvidenceBindingDigest?: string;
  createdBy: string;
  createdAt: string;
  dispositionHash: string;
  signature: string;
}

interface FindingSupersession {
  schemaVersion: 1;
  supersessionId: string;
  predecessorFindingRef: FindingRef;
  successorFindingRef: FindingRef;
  reason: 'incorrect_statement' | 'better_evidence' | 'merged_identity' | 'obsolete_measurement';
  evidenceRefs: string[];
  predecessorHash: string;
  successorHash: string;
  effectiveAt: string;
  createdBy: string;
  recordHash: string;
  signature: string;
}

interface RuntimeEvidenceReceipt {
  schemaVersion: 1;
  receiptId: string;
  storyId: string;
  headHash: string;
  sourceMaterialHash: string;
  buildPolicyDigest: string;
  buildCommandDigest: string;
  executionCommandDigest: string;
  buildCommand: EvidenceBlobRef;
  executionCommand: EvidenceBlobRef;
  stdout: EvidenceBlobRef;
  stderr: EvidenceBlobRef;
  environment: EvidenceBlobRef & { allowlistPolicyDigest: string; excludedVariableNames: string[] };
  artifactManifest: EvidenceBlobRef;
  artifacts: Array<{ path: string; digest: string; sourceHead: string; realpathPolicyDigest: string }>;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdoutDigest: string;
  stderrDigest: string;
  environmentDigest: string;
  toolchain: { compilerVersion: string; runtimeVersion: string; toolchainDigest: string };
  commandCanonicalizationPolicyDigest: string;
  producer: string;
  keyId: string;
  algorithm: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  receiptHash: string;
  signature: string;
}

interface FindingDispositionManifest {
  schemaVersion: 1;
  manifestId: string;
  storyId: string;
  reviewRunId: string;
  assessmentIds: string[];
  dispositions: Array<{
    findingRef: FindingRef;
    assessmentId: string;
    expectedFindingHash: string;
    expectedAssessmentHash: string;
    expectedAssessmentVerdict?: 'applicable' | 'pre_existing_unaffected' | 'out_of_scope' | 'duplicate' | 'not_reproduced_under_current_witness' | 'unknown';
    expectedAssessmentDispositionPlan?: 'repair_current' | 'defer_with_proof';
    action:
      | 'retain_blocker'
      | 'mandatory_repair'
      | 'route'
      | 'canonical_duplicate'
      | 'defer_with_proof'
      | 'retain_unknown';
    deferralId?: string;
    mandatoryRepairId?: string;
    expectedRouteReceiptId?: string;
    expectedRouteReceiptHash?: string;
    expectedRouteReceiptProfile?: 'candidate_route' | 'finding_route';
    expectedRouteReceiptSourceAssessmentProposalId?: string;
    expectedRouteReceiptSourceAssessmentProposalDigest?: string;
    expectedInitialProgressBaselineSetId?: string;
    expectedInitialProgressBaselineSetHash?: string;
  }>;
  scopeDigest: string;
  storyFilesHash: string;
  manifestDigest: string;
  createdBy: string;
  derivationPolicyDigest: string;
  signature: string;
}

interface FindingLedgerReceipt {
  schemaVersion: 1;
  ledgerSchemaEpoch: number;
  minimumWriterCapability: string;
  receiptId: string;
  storyId: string;
  idempotencyKey: string;
  operation:
    | 'append_finding'
    | 'append_legacy_identity_binding'
    | 'append_detector_signal'
    | 'append_candidate_route'
    | 'append_candidate'
    | 'append_assessment_proposal'
    | 'append_assessment'
    | 'append_mandatory_repair'
    | 'append_deferral_expiry_policy'
    | 'append_deferral'
    | 'append_route_receipt'
    | 'append_progress_baseline_set'
    | 'append_material_drift_reattestation'
    | 'append_runtime_receipt'
    | 'append_canonical_defect_supersession'
    | 'append_canonical_defect'
    | 'append_supersession'
    | 'apply_manifest';
  recordIds: string[];
  casBindings: Array<{
    recordType: string;
    expectedRecordId: string;
    expectedRecordHash: string;
    observedChainHeadId: string;
    observedChainHeadHash: string;
    predicateDigest: string;
  }>;
  priorLedgerDigest: string;
  committedLedgerDigest: string;
  replayed: boolean;
  committedAt: string;
  writerSessionId: string;
  writerLeaseId: string;
  writerFenceToken: string;
  keyId: string;
  algorithm: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  receiptHash: string;
  signature: string;
}

interface GateEvaluationSnapshot {
  schemaVersion: 1;
  evaluationId: string;
  storyId: string;
  evaluationScope: 'target_story' | 'canonical_owner' | 'repository_release';
  findingInputs: Array<{
    findingRef: FindingRef;
    findingHash: string;
    assessmentHash?: string;
    assessmentIntegrityStateHash?: string;
    routeDigest?: string;
    ownerDigest?: string;
    canonicalDigest?: string;
    supersessionChainTipDigest?: string;
  }>;
  blockerSetDigest: string;
  scopeDigest: string;
  ledgerSnapshotDigest: string;
  processStateDigest: string;
  processPolicyDigest: string;
  runtimeEvidenceDigest: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  evaluatedAt: string;
  trustedClockDigest: string;
  clockPolicyDigest: string;
  expiryClosure: {
    expiringInputs: Array<{
      type: 'assessment_proposal' | 'assessment_integrity_state' | 'route_receipt'
        | 'deferral_expiry_policy' | 'runtime_receipt'
        | 'finding_deferral_disposition' | 'deferral_lineage';
      recordId: string;
      recordHash: string;
      expiresAt: string;
    }>;
    earliestBoundExpiryAt: string;
  } | {
    expiringInputs: [];
    noExpiry: true;
  };
  commitDeadlineAt: string;
  snapshotHash: string;
  signature: string;
}

interface LegacyFindingIdentityBinding {
  schemaVersion: 1;
  legacy: { storyId: string; findingId: string; findingHash: string };
  recordId: string;
  boundAt: string;
  ledgerSnapshotDigest: string;
  bindingHash: string;
  signature: string;
}
```

For a `defer_with_proof` action, all five `expectedRouteReceipt*` fields are
required and `expectedRouteReceiptProfile` must equal `finding_route`.
Its manifest entry must also name `expectedAssessmentVerdict='applicable'` and
`expectedAssessmentDispositionPlan='defer_with_proof'`; the verifier rejects a
route-free applicable final assessment, a repair-current plan, or any other
verdict for that action.
`expectedRouteReceiptSourceAssessmentProposalId` and
`expectedRouteReceiptSourceAssessmentProposalDigest` must equal the exact
receipt source's `subjectId` and `subjectHash`; `expectedAssessmentHash`
separately binds the final signed assessment and never flows back into the receipt.
The signed `FindingDeferralDisposition` repeats that final assessment hash,
proposal ID/digest, and `assessmentDispositionPlan='defer_with_proof'`; its
verifier rejects an assessment whose verdict/plan/route or exact tuple differs
from the corresponding manifest entry.
`routeReceiptId`, `routeReceiptHash`, `routeReceiptProfile`,
`routeReceiptSourceAssessmentProposalId`, and
`routeReceiptSourceAssessmentProposalDigest` are canonical inputs to
`FindingDeferralDisposition.dispositionHash` and its signature; the matching
manifest action fields are canonical inputs to `manifestDigest` and its
signature. Omitting, reordering, or changing any member changes the applicable
digest and invalidates the signature.
For an initial `defer_with_proof`, both `expectedInitialProgressBaselineSet*`
fields are also required and must match the exact set bound by the accepted
initial `finding_route` receipt. The deferral's baseline set ID/hash are inputs
to `dispositionHash`; the manifest expected ID/hash are inputs to
`manifestDigest`; both signatures and the route receipt's `receiptHash` cover
their respective bindings. Story 1's apply CAS verifies the receipt and baseline
set exact bytes together before writing deferral plus manifest/action.

In enforce, `append_deferral` cannot create an authoritative deferral by itself;
the only authoritative write is `apply_manifest` whose single ledger receipt
names both the deferral and manifest/action and records the exact route-receipt
CAS binding. A failed conditional predicate produces an explicit conflict/refusal
receipt or error but no new deferral/manifest records.

Route acceptance uses a two-stage, immutable assessment construction to avoid a
hash fixed point. `FindingAssessmentProposal` is the lower/shared signed
attachment: its `proposalDigest` canonically covers every field in its envelope
and exact discriminated verdict payload (including basis, owner, current witness,
canonical/base-head/scope dependencies, evaluation scope, evidence, and dependency
bundle) except `proposalDigest` and `proposalSignature`. It excludes every
route field, final-assessment field (`assessmentId`, `assessmentHash`, final
signature), and ledger receipt so it can be constructed before target acceptance.
`proposalSignature` signs that digest using the named proposal signer authority,
key, algorithm, and trust root. Story 3A atomically persists it through
`append_assessment_proposal` and returns one `FindingLedgerReceipt`; its shared
verifier/query API verifies the immutable proposal, signer authority/signature,
currentness, and receipt without importing Story 1.

Only after that verification may Story 2 accept a `finding_route` receipt whose
source binds the exact `proposalId` and `proposalDigest`. The final Story 1
assessment consumes that same durable proposal plus exact receipt tuple and
signs `assessmentProposalDigest` (equal to the proposal's `proposalDigest`) and
the final `assessmentHash`; the receipt neither requires nor contains the final
hash. The final verifier looks up the proposal by ID/digest and rejects a
missing/stale/expired proposal, wrong signer/signature/authority, any payload or
dependency-bundle divergence between final and proposal, a receipt bound to a
final assessment hash, or a non-current receipt. The manifest/deferral binds the
final assessment hash separately from the proposal-digest/receipt tuple, so the
relationship remains exact without self-reference or a Story 2 -> Story 1
dependency.

`FindingDispositionManifest` is a transaction envelope, not a second gate
authority: its actions are the verifier's deterministic derivation from the
signed final assessment verdict/disposition plan and the versioned
`derivationPolicyDigest`. In particular, `defer_with_proof` consumes only an
`applicable + dispositionPlan='defer_with_proof'` final assessment and its exact
proposal ID/digest plus accepted receipt tuple; a route-free
`applicable + repair_current` assessment can derive mandatory repair but never a
deferral. The verifier rejects a missing, extra, reordered, or mismatched action
before the ledger transaction commits.

Every lifecycle decision consumes a signed `GateEvaluationSnapshot`. REVIEW to
TEST, TEST to DONE, and certification/release transitions either evaluate and
commit against the same snapshot transaction or perform a commit-time CAS over
every bound head. Its reader enumerates the complete eligible Finding set from
the ledger snapshot, canonical-sorts immutable FindingRefs, signs every input
and `blockerSetDigest`, and rejects omission, addition, reordering, or display-
ID aliasing. A finding/assessment/integrity/route/owner/canonical/supersession/
scope/ledger/process-policy/runtime/material/story-files mutation aborts the
transition; it is never accepted on a stale preflight result. Commit-time CAS
also obtains the trusted clock, verifies its policy digest, and rejects a
snapshot at or after `expiryClosure.earliestBoundExpiryAt` or after
`commitDeadlineAt`; replay and expiry-between-preflight-and-commit mutations
must abort even with unchanged record bytes. The reader mechanically enumerates
every expiring assessment proposal/integrity state, receipt, policy, runtime
input, active `FindingDeferralDisposition`, and active `DeferralLineageState`.
Each canonical `expiryClosure.expiringInputs` entry binds its type, record ID,
record hash, and `expiresAt`; the non-empty set uses the mechanical minimum of
all entries (including every active deferral/lineage expiry), while only an
empty set may use signed `noExpiry`. Missing, optional, omitted-deferral,
forged-late, clock-drift, boundary, preflight-to-commit race, or replay-race
expiry closures fail closed. The
snapshot's `evaluationScope` is mandatory: `target_story` decides responsibility
for that target only, `canonical_owner` preserves its open applicable obligation,
and `repository_release` independently aggregates open high/critical (and any
stricter release policy) risk. A route can therefore release only the named
target Story, never erase canonical-owner or release risk. Missing or mismatched
scope fails closed. Every consumer calls the same engine with this explicit
scope rather than independently reconstructing a blocker set.

Ledger exactly-once means an application-level exactly-once effect per
idempotency key under the specified writer model: same-host multi-process and
multi-worktree writers sharing the canonical local filesystem, process
crash/kill/retry, stale lock, and partial temporary-write recovery. It is only
as strong as acknowledged `fsync` plus atomic local-filesystem rename after a
power loss. NFS/shared multi-host writes and hardware/disk corruption are out of
that claim: enforce refuses them unless a future adapter supplies an equivalent
fencing/durability contract. Every enforce writer has a current
`ledgerSchemaEpoch`, `minimumWriterCapability`, lease, and monotonic fence token;
legacy or stale-fenced writers are refused. A receipt signs its commit metadata
(including key ID and algorithm) once and never produces a receipt for itself.

`FindingRouteReceipt.routeSubjectDigest` is the canonical digest of its source,
target, owner/authority, decision/timestamps, predecessor, and policy fields,
excluding `initialProgressBaselineSet`, `progressEvidence`, `receiptHash`, and
`signature`. Baseline/progress records bind the receipt ID plus this subject
digest, while the final receipt hash/signature bind the nested baseline-set or
progress digest. This acyclic construction prevents a caller from fabricating a
self-referential receipt hash; Story 1 still CAS-checks the final receipt hash
and exact bytes.

`ProgressEvidenceBinding.tupleDigest` is the digest of the canonical,
field-name-sorted tuple containing `kind`, evidence ID/hash/signature/
`producedAt`, subject canonical defect/route/contract/acceptance bindings, the
kind-specific `ProgressProjection`, both projection digests, the complete target
snapshot, `previousDeferralId`, and `predecessorBaselineDigest`. Array and object
insertion order is not semantic; the canonical encoder rejects duplicate keys
and non-canonical encodings. The outer receipt signature covers the complete
binding, while the nested evidence signature proves target-authorized
production of the named evidence.
The top-level `kind` must equal `projection.kind`; canonical defect and exact
route ID/subject digest are mandatory for every kind. Source/test projections require a
matching affected-contract binding, delivery projections require the named
acceptance/checklist item, and status transitions require the target-owned
defect work item and an allowed transition-policy receipt. Empty or cross-kind
subject bindings are invalid.
`InitialProgressBaselineSet` is target-authorized, CLI/server-derived, and
contains exactly one signed entry for each eligible progress kind. Every entry
binds the same canonical defect, initial route ID/subject digest, relevant contract/target
item/command subject, capture time, target authority snapshot, and either a
canonical present projection/digest or a canonical absent marker/digest. Present
requires `projection` plus `projectionDigest` and forbids `absenceDigest`;
absent requires `absenceDigest` and forbids projection fields. Duplicate/missing
kinds, wrong subject/route, non-target signer, non-CLI/server producer, stale
capture, or any entry/set hash/signature mismatch invalidates the set.
The set encoder stores the four entries in canonical `ProgressEvidenceKind`
order; caller array order is not semantic and duplicate or unknown kind keys are
rejected before hashing.
Every entry and the set itself must carry the exact
`evidenceAuthority={profile:'progress_baseline',
authority:'target_route_semantic_only', gateEvidence:false}` marker. Each
entry's `baselineHash`/signature and the set's `baselineSetHash`/signature cover
that marker. Removing or changing any marker member, or presenting a baseline
as a receipt, L4 artifact, or other profile, invalidates the record; a valid
marker still proves only target-route baseline semantics and has zero direct
lifecycle authority.

For renewal, `predecessorProjectionDigest` is derived by the verifier from the
signed predecessor baseline set entry of the same kind; callers cannot supply or
override it. An initial absent entry may advance to a later defect-bound test,
delivery, or status projection even when code is unchanged. Digest inequality
alone is not progress: kind-specific semantics must reject no-op, regressive,
wrong-subject, and unrelated transitions.
`FindingDeferralDisposition.target.targetSnapshotDigest` is the canonical digest
of the accepted receipt's target kind/ID/scope and current target head/material/
story-files snapshot at apply time. It is the next renewal's immutable freshness
baseline, but whole-repository snapshot change is never itself semantic
progress; only the kind-specific projection comparison can prove progress.

`DeferralLineageState.hasHistoricalClaim`, `claimDeferralIds`, and both claim
digests are derived from ledger records and canonical supersession/merge links,
not copied from `FindingApplicabilityAssessment`. `not_present` requires
`hasHistoricalClaim=false` plus an empty, complete claim scan. If any committed
deferral is reachable, `hasHistoricalClaim=true`; absent/stale/tampered or
lineage-omitting replacement assessment maps to missing/stale/tampered/unknown,
not `not_present`. `validity='released'` requires the signed
`DeferralLineageRelease` strong-proof or closure artifact; no other state may
silently discard the historical claim.

The existing `Finding` remains the verified observation type. A candidate is
not a Finding. A canonical defect is not an applicability verdict. A ledger
receipt proves persistence, not truth. A runtime receipt proves what was run,
not whether the resulting problem belongs to the Story.
`CanonicalDefect.rootCause` is present only when the paired state is
`hypothesized` or `confirmed`; those states require a non-empty cause plus
evidence, while `unknown` requires the field to be absent. A deferral's
`canonicalDefectId` proves stable semantic identity, not a known cause, and must
never force callers to fabricate one. Cause corrections use a new canonical
record/supersession link with evidence.

## 7. Shared gate contract

### 7.1 One authoritative predicate

Enforcement must extend one shared predicate rather than adding per-consumer
interpretations:

```ts
isDynamicFindingBlocking(
  finding,
  verifiedAssessmentState,
  assessmentIntegrityState,
  mandatoryRepairState,
  deferralState,
  deferralLineageState,
  policy,
  round
) =
  if deferralLineageFloorBlocks(
    finding,
    deferralLineageState
  ) then true
  else if assessmentIntegrityFloorBlocks(
    finding,
    assessmentIntegrityState
  ) then true
  else if mandatoryRepairFloorBlocks(
    finding,
    verifiedAssessmentState,
    mandatoryRepairState
  ) then true
  else finding.status === 'open'
    && policy.effectiveBlockingSeverities.includes(finding.severity)
    && isEvidenceStateBlocking(finding.evidenceState)
    && !isAdvisoryThisRound(finding.severity, round)
    && applicabilityAndDispositionBlocks(
      finding,
      verifiedAssessmentState,
      deferralState
    )
```

`verifiedAssessmentState` is the signed assessment reader's validated projection,
not a caller-supplied/raw assessment object. The assessment signer/verifier uses
the raw assessment only to mint or validate `AssessmentIntegrityState`; the
predicate never re-derives integrity from that raw input. In enforce,
`assessmentIntegrityFloorBlocks` accepts only the signature-valid,
story/finding/head/material/story-files/scope/runtime/process-policy-bound
`AssessmentIntegrityState` returned by its registered reader. A missing,
invalid, mismatched, or unavailable integrity state is itself a fail-closed
`blocking_invalid` result; no consumer may substitute a local derivation.

The verifier-derived lineage check is deliberately first and derives claim
existence independently from immutable deferral records plus the canonical
supersession/merge chain before consulting any current assessment. A current
assessment cannot erase a prior claim by being missing, stale, tampered, or by
omitting the old lineage. If `hasHistoricalClaim=true` and there is no valid
strong release, `missing`, `stale`, `expired`, `exhausted`, `tampered`, or
`pending_re_attestation`/`unknown` validity blocks directly. Scope, `storyFilesHash`, material, and
runtime drift therefore turn the derived state stale/unknown and remain in this
first floor even when no replacement assessment exists. `boundary='exact'` is
already expired, and an unknown clock or lineage result at that boundary also
blocks.

For `hasHistoricalClaim=true`, any raw `materialHash` mismatch first projects
`materialDriftState='pending_re_attestation'` and blocks here even when
`storyFilesHash` matches. The host cannot self-classify it as unrelated. Authority
returns to `valid` only after a current signed L4 `MaterialDriftReattestation`,
or a new assessment carrying equivalent gate-consumed proof, confirms unchanged
`storyFilesHash` and no impact to every bound runtime receipt, process-policy,
route-receipt, and canonical-dependency digest. Any changed/unknown dependency,
or missing/stale/tampered re-attestation, projects stale/unknown and blocks.
This proof need not trigger a full re-review when all related bindings are
unchanged, but it is mandatory gate evidence for continued deferral authority.

This computation does not depend on a fresh `applicable` assessment or a
successful `MandatoryRepairClassification` append. It remains blocking when
that audit append is missing, fails, or races another writer, and it runs before
Finding status/severity, `effectiveBlockingSeverities`, evidence-state, or
`isAdvisoryThisRound` short-circuits. `not_present` is allowed only when the
ledger/canonical-chain reader proves no committed deferral has ever existed for
the Finding/defect lineage; an assessment omission cannot produce it. Only a
fresh exact-receipt-CAS-valid `valid` lineage can supply deferral authority.
For this floor, an unclosed direct status mutation does not erase the durable
open/applicable obligation; only the existing complete closure contract permits
the subsequent resolved projection.

The only other lineage-floor release is a fresh signed superseding
`pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying its
independent strong proof contract, or a signed `disproven` truth transition with
current counter-evidence. `DeferralLineageRelease` binds that exact artifact and
proof digest. Advisory history, a replacement `applicable`/`unknown` assessment,
or a new assessment that omits the old deferral cannot release the floor.

The two assessment-related pre-round floors are deliberately different. Define
the exact required-assessment invalid set once as:

```text
REQUIRED_ASSESSMENT_INVALID = {
  missing, re_attestation_required, stale, unsigned, tampered, mismatched,
  incomplete, expired, unknown
}
```

The **assessment-integrity floor** is a verifier-derived transient projection,
not a `MandatoryRepairClassification` and not evidence that the Finding is
applicable. It exists when a Finding is verified, open, high/critical, and its
registered signer/verifier/reader derives a signed `AssessmentIntegrityState`
whose required assessment is in `REQUIRED_ASSESSMENT_INVALID`. It runs before
severity and round/advisory policy, so none of those policies can decay or
bypass it. Here, "non-decaying" means only that ordinary severity, round, and
advisory rules cannot waive missing integrity evidence; it does not mean the
projection is permanent or that Red/root-cause/fix/Green is required to release
it. The verifier recomputes and signs it from the validated assessment reader:

- a later fresh, signed, strongly proven `pre_existing_unaffected`,
  `out_of_scope`, `duplicate`, or `not_reproduced_under_current_witness` verdict
  that passes its independent proof
  contract releases the assessment-integrity floor and is non-blocking when no
  independent lineage or mandatory-repair obligation exists;
- a later fresh signed `applicable` verdict removes the integrity floor but, for
  high/critical, immediately enters the distinct mandatory-repair floor;
- a later `unknown`, weakly proven non-applicable, or otherwise missing,
  re-attestation-required, stale, unsigned, tampered, mismatched, incomplete,
  or expired assessment remains in the
  assessment-integrity floor.

Because this projection is derived rather than an append-only repair record,
there is no stale `required` classification to supersede on the first
transition. A clean initial fresh strong non-applicable assessment and a
missing-to-fresh-strong-non-applicable transition must produce the same final
gate result.

The **mandatory-repair floor** is the confirmed repair obligation. It is also
checked before ordinary policy and is created by a fresh `applicable`
high/critical assessment, any known or unknown protected-surface risk or
missing protected-surface evaluation, or an exhausted/invalid deferral lineage.
This floor remains blocking even when severity would fall out of
`effectiveBlockingSeverities`, `isAdvisoryThisRound` would return true, or an
invalid direct write marked the Finding resolved. A missing, stale, unsigned,
tampered, mismatched, incomplete, or unknown required classification/closure
also blocks. For an invalid deferral lineage,
`MandatoryRepairClassification(state='required')` is an append-only audit
receipt and recall anchor, not the sole source of the safety result: the shared
predicate derives the floor from `DeferralLineageState` even if recording that
classification fails.

For an active mandatory-repair obligation, the only clearing state is a fresh signed superseding
`MandatoryRepairClassification(state='closure_proven')` containing Red/current
reproduction, root-cause, fix, Green, and closure evidence bound to current
source/runtime material. Resolution/dismissal handlers must refuse an active
mandatory-repair floor; they may clear/resolve only after that closure validator
passes. This closure-only rule does not apply to the assessment-integrity floor,
which has not confirmed applicability and follows the transitions above. A
fresh strong non-applicable verdict (`pre_existing_unaffected`, `out_of_scope`,
`duplicate`, or target-bound strong `not_reproduced_under_current_witness`) does not create a mandatory-repair floor. In warn/rollback mode
the new classification is advisory and the exact previous predicate is restored.

For `state='required'`, `closure` must be absent. For
`state='closure_proven'`, `supersedesMandatoryRepairId` must name the active
required record and every closure evidence array must be non-empty, current,
signature-valid, and mutually bound to the same Finding, Story, source/runtime
material, and repair. The validator rejects a closure-only first record,
self-supersession, cycles, stale evidence, or a partial chain.

`applicabilityAndDispositionBlocks` is:

```text
fresh signed applicable assessment, no valid deferral      -> true
fresh applicable assessment + valid low/medium deferral    -> false
required assessment in {missing, re_attestation_required, stale, unsigned,
tampered, mismatched, incomplete, expired, unknown} on a verified open
high/critical Finding                                      -> assessment-integrity
                                                               floor before round/
                                                               advisory; blocks
fresh strong non-applicable verdict on high/critical       -> integrity floor releases;
                                                               independent proof
                                                               determines non-blocking
fresh applicable verdict on high/critical                  -> integrity floor releases;
                                                               mandatory-repair floor blocks
weak or invalid non-applicable verdict on high/critical    -> integrity floor remains;
                                                               blocks
claimed missing/stale/expired/exhausted/tampered/unknown
lineage, independent of current assessment                 -> first safety floor
claimed lineage + fresh strong superseding release         -> released only by
                                                               its proof contract
fresh non-blocking verdict with all required proof          -> false
```

Thus applicability can remove a blocker only with stronger structured proof.
It cannot create a shortcut around the current evidence/severity/round policy.
In particular, an unknown high or critical Finding never becomes non-blocking
merely because classification failed: every state in
`REQUIRED_ASSESSMENT_INVALID` enters the assessment-integrity floor before round
decay. A fresh, strongly proven non-applicable high/critical verdict releases
that temporary floor and is evaluated by its own proof contract; a fresh
applicable verdict converts to mandatory repair. Outside the two pre-round
floors, current round-decay semantics continue to apply; invalid assessment
state does not create an extra downgrade.

Legacy Findings with no assessment remain readable. In enforce mode, a missing
assessment projects to `unknown`; a verified open high/critical Finding enters
the assessment-integrity floor before the previous round/advisory predicate,
while a fresh strong non-applicable assessment may release that projection and
independently prove it non-blocking. This does not manufacture an applicable
repair obligation. Legacy missing `evidenceState` keeps the current compatibility
projection to verified. No bulk rewrite is needed.

### 7.2 Candidate routing and defer-with-proof disposition

The mechanism has three paths. They deliberately require different proof so
that early routing does not consume the repair time it is intended to save.

**Path A — suspected low/medium candidate route.** A suspected observation may
be retained and routed as a non-authoritative `CandidateFinding` before
promotion. Its `CandidateRoute` must include an explicit `uncertaintyReason`,
current evidence references, a live owner, an existing Story or B-META gap, a
signed route receipt, freshness bindings, expiry, and recall triggers. It does
not require Finding promotion, deterministic reproduction, root-cause evidence,
or Green evidence. It never enters a lifecycle blocker set and cannot block or
unblock the current Story. Missing uncertainty, evidence, owner, target, or
route receipt rejects the candidate route rather than manufacturing a Finding
or deferral. Story 2 may first persist the target-authorized receipt as a
standalone non-gate record through Story 3. A later candidate-route CAS validates
that exact immutable receipt and latest-chain state before writing the route.
Receipt-alone is legal and has zero gate effect; a candidate route whose bound
receipt is missing or invalid is non-authoritative.

**Path B — verified applicable low/medium deferral.** Defer-with-proof applies
only after current reproducible failure evidence establishes a
`verified + applicable` low/medium Finding. Root-cause evidence may be recorded
when already known but is not required for deferral; root-cause analysis, repair,
and fresh Green evidence belong to the receipted target Story. All of the
following are mandatory:

- A final `applicable` assessment declares exactly one disposition plan:
  `repair_current` forbids `acceptedRoute`, while `defer_with_proof` requires the
  exact accepted `finding_route` tuple for its durable proposal ID/digest. This
  union makes both final applicable paths constructible, but is not eligibility:
  critical/high or any known/uncertain protected-surface case can never choose
  `defer_with_proof` even with a valid receipt; an otherwise eligible low/medium
  applicable case may choose either `repair_current` or `defer_with_proof`.

- The Finding has no direct relationship to the current acceptance contract or
  any `verificationIntent`; `acceptanceImpact` names the inspected references
  and evidence rather than relying on an empty assertion.
- `introducedByCurrentStory=false` is supported by current base/head evidence.
  A regression introduced or worsened by the Story cannot be deferred.
- `protectedSurfaceImpact.affected=false` is proven across data integrity,
  security/privacy, package publish and clean install, the primary CLI
  entrypoint, Agent resolution, historical evidence integrity, and lifecycle
  gates. Uncertainty on any protected surface is ineligible.
- `canonicalDefectId`, `reasonCode`, current reproduction evidence, a non-expired
  freshness binding, and a valid owner are present. The target must already
  exist as another Story or a B-META gap. The target binds both
  `routeReceiptId` and `routeReceiptHash`, plus the `finding_route` profile and
  exact source-assessment proposal ID/digest, to prove the target/owner accepted
  this immutable proposal. A promise to create a target later is insufficient.
- The initial accepted route and initial deferral bind the exact target-signed
  `InitialProgressBaselineSet` ID/hash containing all four eligible kinds; a
  missing, incomplete, tampered, wrong-route/defect/subject, or stale set is
  ineligible.
- `recheckTriggers` and `expiresAt` are present. Story 1 applies the deferral and
  its manifest/action atomically in a transaction separate from Story 2's
  earlier standalone receipt transaction. Under the same lock/transaction it
  compares the expected receipt ID/hash/profile/source-assessment proposal ID/digest
  and expected baseline-set ID/hash to the latest receipt-chain/baseline bytes, then
  rechecks freshness and absence of revocation or supersession. Any mismatch or
  state change aborts with neither a deferral nor manifest/action written.
- `expiryPolicyVersion` and `policyDigest` bind the disposition to the current
  signed `DeferralExpiryPolicy`. Version 1 permits medium at most 7 * 24 hours
  cumulatively with zero renewals, and low at most 30 * 24 hours cumulatively
  with at most one renewal. `firstDeferredAt`, lineage root/digest, observed
  severities, cumulative horizon, and renewal count come from the canonical
  ledger lineage rather than caller input. The route receipt must remain
  accepted and valid through `expiresAt`.
- The policy verifier requires the exact supported schema/version, valid
  command-policy-authority signature, recomputed `policyDigest`, an
  `effectiveAt` no later than disposition creation, exact V1 7/30-day constants,
  renewal limits, and 30-day hard ceiling. A wrong/not-yet-effective/tampered
  policy or disposition policy-version/digest mismatch aborts deferral apply.
  Policy supersession is append-only and applies only to later dispositions; it
  cannot rebind existing rows or reset their ledger-derived `firstDeferredAt`,
  renewal count, or cumulative horizon.

**Path C — current-Story mandatory repair.** A verified applicable
`critical`/`high` Finding cannot be deferred. Neither can any Finding with known
or uncertain data-integrity, security/privacy, package publish/clean-install,
primary CLI entrypoint, Agent-resolution, historical-evidence-integrity, or
lifecycle-gate impact, regardless of assigned severity. The current Story must
record Red/reproduction evidence, establish root cause, fix the defect, and
record fresh Green/closure evidence before the blocker can clear. A signed
`MandatoryRepairClassification(state='required')` represents this non-decaying
floor until a fresh superseding `closure_proven` record validates the complete
chain. An otherwise eligible low/medium Finding also enters this path when its
cumulative deferral horizon or renewal count is exhausted, its lineage is
tampered, or a requested renewal lacks target-authorized progress evidence.

Deferral is a disposition after `applicable`, not another applicability verdict.
It does not mean `out_of_scope`, `pre_existing_unaffected`, `duplicate`,
`disproven`, resolved, or dismissed; those existing verdict/truth paths retain
their stronger independent proof contracts. The Finding truth, severity, and
status do not change. It remains open and operator-visible as advisory with its
canonical defect, reason, owner, target, expiry, and recall triggers.

Triage is complete only when every otherwise-blocking open Finding has a valid
current assessment, every applicable mandatory condition has a matching fresh
classification/manifest action, and every `defer_with_proof` action has a
matching signed deferral plus the exact CAS-bound receipt ID/hash/profile/source
assessment proposal ID/digest. A valid deferred low/medium Finding
does not block the current Story. A missing, invalid, expired, tampered,
ownerless, or partially applied claimed deferral produces invalid
`DeferralLineageState` and enters the current mandatory floor in enforce; in
warn/rollback it restores only the previous authoritative predicate. It is never
interpreted as a waiver, pass, or terminal Finding outcome.
Candidate-route completeness is audited separately: valid and invalid candidate
routes produce the same gate decision, so neither can substitute for Finding
triage or act as a waiver.

### 7.3 Target-side route acceptance and finite expiry

`FindingRouteReceipt` is semantic proof that the named target accepted or
rejected the exact source subject; it is not merely a source-Story routing note
or a ledger commit receipt. The source Story cannot self-sign target acceptance.

- For `existing_story`, only the target-authorized Story owner or an actor
  authorized for that target by current command policy may accept. The receipt
  binds the active owner identity plus its lease ID or authority-policy version.
- For `b_meta_gap`, only the canonical B-META audit authority or main-write
  authority may accept. A current-Story reviewer, author, or generic ledger
  writer is insufficient.
- Every acceptance names the exact target responsibility: an immutable target
  `FindingRef`, or a target work-item ref plus hash. The target must exist, be
  in a state allowed to receive the obligation, and be accepted by its current
  owner authority. The signer computes `routeChainDigest` and visited targets;
  A -> B -> A (or any longer cycle) is refused rather than hidden by a route.
- `acceptedAt` is required only for `decision='accepted'`; `rejectedAt` is
  required only for rejection, and the opposite timestamp must be absent.
  Source kind/ID/hash/Story, target kind/ID/state/scope, owner identity/authority,
  policy digest, and signer authority must all match.
- Wrong target, owner, signer, source hash, or policy digest; a stale/closed
  target; owner/lease/policy change; explicit revocation; expiry; tamper; or a
  failed exact-reference CAS makes the referencing candidate route or deferral
  invalid. A durably committed receipt remains a legal standalone non-gate
  record, but it cannot authorize a candidate route or deferral after any of
  those semantic invalidations.
- Rejection or later revocation is a new signed receipt naming the predecessor
  in `supersedesRouteReceiptId`; immutable accepted bytes are never edited in
  place. `revokedAt` requires `revocationReason` and a predecessor. The latest
  fresh valid receipt in that chain is authoritative.
- Resolving, dismissing, superseding, or closing the target responsibility;
  changing its owner/target; or changing its authority/lease revokes or stales
  the receipt and triggers recall. It cannot leave a source Finding silently
  non-blocking. B-META acceptance remains limited to its canonical policy
  authority; a generic B-META writer cannot sign it.
- An accepted initial `finding_route` receipt must bind a complete target-signed
  `InitialProgressBaselineSet` ID/hash. Story 2's transaction persists the
  receipt and set atomically; neither a missing set nor a set attached later can
  authorize an initial deferral. Candidate-route and renewal receipts do not
  fabricate this initial set.
- `progressEvidence` is allowed only on an accepted `finding_route` renewal
  receipt and is absent for candidate routes and initial deferrals.

Story 2 owns the base target-side semantic contract, acceptance/rejection/
revocation commands, signer/verifier, target-authority checks, and freshness
reader used by `CandidateRoute`. Every Story 2 receipt has
`gateEvidence=false`, including a receipt whose source is a Finding assessment
proposal;
it proves target acceptance but cannot change lifecycle state by itself. Story 2
may atomically persist a standalone candidate/renewal receipt or the initial
finding-route receipt plus baseline set through Story 3 without calling Story 1.
Story 1 later opens a separate ledger CAS transaction, reads the latest
route-receipt chain and initial baseline-set bytes under the transaction lock,
validates the expected ID/hash/`finding_route` profile/source-assessment proposal ID/digest,
baseline-set ID/hash/completeness/signatures, freshness, and absence of
revocation or supersession, and atomically writes the signed L4
`FindingDeferralDisposition` plus its matching manifest/action. Story 1 does not
redefine receipt signing or require Story 2 to call a Story 1 command. Story 3
only provides the atomic/CAS primitive and persists signed bytes; its ledger
receipt confers no semantic authority. A receipt alone is legal but never gates;
a deferral without its manifest/action/baseline binding, or one whose exact
bound receipt or baseline set later becomes invalid, has no deferral authority.

Deferral renewal is append-only and bounded across the full semantic lineage,
not per row:

- The ledger derives `firstDeferredAt` as the earliest deferral time reachable
  through the canonical defect and its supersession/merge lineage.
  `renewalCount` is the number of renewal edges in that lineage, and
  `lineageDigest` binds all contributing canonical/deferral IDs and hashes.
- V1 medium has a cumulative horizon of 7 * 24 hours from `firstDeferredAt` and
  `maxRenewalCount=0`. V1 low has a cumulative horizon of 30 * 24 hours and
  `maxRenewalCount=1`. The effective lineage class is the most restrictive
  severity ever observed: low -> medium adopts the 7-day/zero-renewal limits,
  while medium -> low cannot relax them. Any transition to high/critical ends
  deferral immediately and enters the pre-existing mandatory-repair floor.
- Changing target, owner, severity, Story, canonical ID, or deferral row cannot
  reset the clock or count. Canonical merge inherits the earliest timestamp and
  all renewal edges; a split conservatively gives each successor the predecessor
  timestamp/count until explicit identity adjudication proves independence.
- A permitted low renewal requires a fresh assessment, a new Story 2
  target-authorized route receipt, and a typed `ProgressEvidenceBinding`
  produced after the predecessor deferral. At renewal time its evidence
  signature, signer authority, target ID/scope and current head/material target
  snapshot must still verify. `predecessorBaselineDigest` must equal the
  verifier-selected signed baseline entry hash for the same kind, while the
  predecessor target snapshot remains a separate freshness/authority check.
  Progress requires the new kind-specific
  `projectionDigest` to differ semantically from the predecessor's exact
  `predecessorProjectionDigest` for the same canonical defect and route:
  source change compares affected source/contract digest; test result compares
  defect-bound command/selector/outcome receipt; delivery state compares a
  target acceptance/checklist item's signed state and evidence; status
  transition compares an allowed target-owned defect-work transition and
  process receipt. Real test, delivery, or status progress may therefore pass
  with unchanged source bytes, while unrelated repository/head/material change
  is never progress. Stale, cross-target, wrong-defect/route/contract/item/
  command, reordered, replayed, or re-signed-without-semantic-transition tuples
  are insufficient.
- An initial deferral has `renewalCount=0`, no `supersedesDeferralId`, no
  `progressEvidenceBindingDigest`, and names itself as
  `lineageRootDeferralId`; its `initialProgressBaselineSetId`/hash match the
  initial route receipt. A
  renewal increments the ledger-derived count exactly once,
  `progressEvidenceBindingDigest` equals the exact bound route receipt's
  `progressEvidence.tupleDigest`, and that binding's `previousDeferralId` equals
  `supersedesDeferralId`. The verifier derives
  `predecessorProjectionDigest` from that signed predecessor baseline set's same-
  kind entry; missing/tampered/wrong-kind/wrong-subject entries fail closed. Its
  canonical tuple bytes, not caller field order, determine the digest.
- `expiresAt` is never edited or extended in place and must satisfy
  `createdAt < expiresAt <= firstDeferredAt + effective cumulative horizon`.
  The new deferral names its predecessor in `supersedesDeferralId`; the old row
  remains auditable.

V1 parses strict UTC timestamps against the CLI's trusted clock and rejects an
invalid/future `createdAt`, non-monotonic timestamp, overflow, chain gap/cycle/
hash tamper, or already-overdue proposal. Missing progress, an exhausted count,
or the exact cumulative-horizon boundary invalidates advisory deferral and emits
exactly-once recall plus a best-effort `MandatoryRepairClassification` audit
record with reason `deferral_lineage_exhausted`; the verifier-derived
`DeferralLineageState` makes the current gate blocking even if that audit append
fails or races another writer.

### 7.4 Proof required for a non-blocking verdict

| Verdict | Minimum proof before it may be non-blocking |
| --- | --- |
| `pre_existing_unaffected` | Deterministic base and head reproduction receipts; same defect exists at base and head; Story does not worsen severity/impact; Story scope does not promise its repair; valid owner/route |
| `out_of_scope` | Signed scope/decision evidence naming the excluded contract; no contradictory checklist/acceptance promise; route to a valid owner; high/critical cannot be left unowned |
| `duplicate` | Reviewer-confirmed canonical defect; referenced canonical Finding exists and is signature-valid; live owning Story/Finding is named; no circular duplicate chain |
| `not_reproduced_under_current_witness` | Current target-bound negative command/runtime receipts, signed command-policy and witness digest, plus a live receipted owner/route; it releases the transient integrity floor under the same strong-proof contract, never a mandatory-repair or claimed-lineage floor, and is not inferred from an old DONE outcome |
| `unknown` | Never a non-blocking reason for an otherwise blocking Finding |

File disjointness, model confidence, historical similarity, a signature tag,
source-lineage equality, or an old out-of-scope result is insufficient.

### 7.5 Freshness and recall rules

- Assessment freshness is independent of verdict and cannot be self-signed. A
  signed assessment carries only `issuedAt`, policy-bound `expiresAt`,
  `freshnessPolicyVersion`, and `maxAgeSeconds`; its registered verifier writes
  the signed integrity state's `freshness` as only `fresh`,
  `re_attestation_required`, `stale`, `tampered`, `missing`, or `expired`.
  Dependency drift immediately invalidates the assessment, and missing or
  expired assessments are never gate input. The policy, not this specification,
  chooses any duration. `not_reproduced_under_current_witness` remains a
  current-evidence verdict and cannot be used as a freshness alias. Raw
  assessments cannot declare themselves fresh.
- The signed dependency bundle covers the exact source `FindingRef`/hash/version,
  canonical identity/current canonical Finding and supersession-chain tip where
  used, accepted owner/route digest where used, proof-policy digest,
  reviewer-authority policy digest, and ledger snapshot digest. The integrity
  state binds that bundle digest. Any dependency change therefore becomes stale
  and fails closed instead of being reinterpreted by a consumer.
- Matching `materialHash`, `storyFilesHash`, scope digest, and required runtime
  receipts: fresh.
- For `hasHistoricalClaim=true`, any raw `materialHash` mismatch is
  `pending_re_attestation`/unknown and first-floor blocking, including when the
  signed `storyFilesHash` matches. The host must not infer unrelated drift or
  preserve `valid` from hash shape alone.
- A current signed, L4/gate-consumed `MaterialDriftReattestation` (or equivalent
  proof inside a new assessment) may classify the drift `unrelated` only when it
  binds the prior/current material hashes, proves unchanged `storyFilesHash`,
  and revalidates every bound runtime-receipt digest, process-policy digest,
  route ID/hash, and canonical-dependency digest as unaffected. Then, and only
  then, `materialDriftState='unrelated_re_attested'` may restore `valid`.
- Any related dependency change or unknown comparison is stale and blocking.
  Missing, stale, unsigned, tampered, wrong-story/finding/deferral, or digest-
  mismatched re-attestation is unknown/tampered and blocking. The unchanged-
  dependency outcome may remain a no-full-re-review advisory, but the signed
  re-attestation itself is necessary gate evidence, not optional host narration.
- Changed `storyFilesHash`: stale; current Story-owned material changed.
- Changed scope digest: stale; an old out-of-scope/applicable decision cannot
  survive a scope change.
- Changed/missing runtime artifact digest or mismatched source-head receipt:
  stale.
- Missing current `storyFilesHash`: strict `materialHash` fallback.
- Invalid assessment or receipt signature/hash: tampered and fail closed.
- A ledger/canonical-chain claim scan always precedes assessment freshness.
  Once any deferral is committed, no replacement assessment, absent assessment,
  or omitted lineage field can make `hasHistoricalClaim=false`. Missing,
  tampered, or scope/story-files/material/runtime-stale replacement assessment
  produces the corresponding missing/stale/tampered/unknown lineage state and
  the first floor until a strong signed release or complete repair closure.
- A rejected, revoked, expired, wrong-authority, owner/lease/policy-stale, or
  target-closed `FindingRouteReceipt` is invalid. A deferral cannot outlive its
  route receipt or its canonical-lineage cumulative V1 horizon.
- The deferral reader requires its bound route receipt ID and hash to be the
  latest chain head with `profile='finding_route'` and source `subjectId`/
  `subjectHash` equal to the bound proposal ID/digest (not the final assessment
  hash). A successor, revocation, stale target, or exact-byte/hash mismatch
  invalidates the deferral without rewriting it.
- A severity/target/owner/Story/canonical-ID change, canonical supersession or
  merge/split, or a new deferral row causes lineage recomputation; none resets
  `firstDeferredAt` or `renewalCount`. A gap, cycle, digest mismatch, missing
  progress, or exhausted lineage fails closed into mandatory repair.
- Renewal freshness also revalidates the typed progress tuple against the
  predecessor kind-specific projection and current target authority snapshot.
  Unrelated source/head/material change, wrong defect/route/contract/item/
  command, stale production time, tuple reordering, replay into another renewal,
  or a new signature without a semantic projection transition fails closed.
- Creating or starting the target Story/gap, scope drift, material or
  `storyFilesHash` drift, runtime-binding drift, a changed affected contract,
  severity escalation, owner invalidation, target closure without a Green fix,
  or `expiresAt` recalls the routed candidate or canonical defect as a new
  `CandidateFinding` and requires a new current candidate adjudication. Only if
  current verification promotes it does a new assessment/deferral decision
  become possible.
### 7.6 Consumers and process-fact contract

The implementation Story must first re-run this source search to discover the
complete current consumer set:

```bash
rg -n "isFindingBlocking|isEvidenceStateBlocking|blockingFindings" \
  packages/main/src/core packages/main/src/handlers
```

At this plan's HEAD the shared current predicate is consumed by or projected
through at least:

- `core/machine.ts` (`canPassReview`)
- `core/guard-utils.ts` (failure reason)
- `core/reviewer-status.ts`
- `core/lifecycle-readiness.ts`
- `handlers/certification-window.ts`
- `handlers/reviewer-batch.ts`
- `core/review-convergence.ts`

They must all use the same assessment reader and predicate. Certification,
review status, convergence diagnostics, and transition refusal must not disagree
about the blocker set. Review assurance and escalation floors remain intact;
the new projection must not lower their current guarantee.

Each registered consumer additionally passes `evaluationScope` to the same
engine and commits a matching `GateEvaluationSnapshot`: REVIEW/TEST target
transitions use `target_story`, canonical-owner work uses `canonical_owner`, and
certification/release uses `repository_release`. Fixtures mutate every snapshot
digest and race each transition commit, assert a CAS refusal, verify that a
strong non-applicable target decision cannot release its canonical owner or
release aggregate, and reject omitted/mislabelled scope. No consumer may retain
a second cached or locally derived authority.

Because verified-Finding applicability, assessment integrity, mandatory repair,
deferral, and freshness change REVIEW/TEST/DONE blocker state, their writers,
signed artifacts, triage-completeness semantics, and shared runtime predicate
are L4 process facts. `AssessmentIntegrityState` is a Story 1 L4 artifact: its
signer, verifier, and reader bind the exact Finding, Story, assessment, head,
material, story-files, scope, runtime-evidence, and process-policy digests, and
its only gate consumer is the registered `isDynamicFindingBlocking` dependency.
Story 2 route acceptance is a required signed semantic dependency but remains
non-gate; only Story 1's deferral binds its receipt into L4 state.
`CandidateRoute`, standalone `FindingRouteReceipt`, every
`InitialProgressBaseline`, and `InitialProgressBaselineSet` are explicitly
outside that authority boundary; their non-gate semantics must be mechanically
preserved. Future implementation must update:

- `packages/main/src/core/process-fact-levels.ts`
- `packages/main/src/core/process-fact-registry.ts`
- `packages/main/src/core/command-policy.ts`
- the command catalog/registry and phase allow-lists
- `scripts/verify-process-fact-contract.mjs`

`PROCESS_FACT_LEVELS`, `COMMAND_POLICIES`, and the process-fact registry must
explicitly register the `AssessmentIntegrityState` derive/sign, verify, and read
operations; its L4 artifact and required semantics; the exact
`REQUIRED_ASSESSMENT_INVALID` nine-state set; its release/convert/remain state
machine; and `isDynamicFindingBlocking` as its sole shared-predicate gate
consumer. The registry/contract verifier must also explicitly enumerate Story 2's non-gate
route accept/reject/revoke handlers and `FindingRouteReceipt` artifact separately
from the non-gate `progress_baseline` entry/set capture, sign, verify, and read
handlers/artifacts, and all of those must be separate
from Story 1's L4 mandatory-repair classify/close and deferral create/supersede
handlers. It must register Story 1's exact receipt-hash/profile dependency,
source-assessment proposal ID/digest, CAS apply handler, `DeferralLineageState`,
`MaterialDriftReattestation`, initial-baseline ID/hash CAS,
`MandatoryRepairClassification`, `DeferralExpiryPolicy`, cumulative-lineage
reader, `AssessmentIntegrityState` reader dependency, every shared-predicate
consumer, and negative tests proving no direct resolve/dismiss or per-consumer
path bypasses either floor. The registered shared predicate must consume the
signature-valid integrity state and verifier-derived lineage state before
status/severity/round policy, and must not depend on successful
classification-audit persistence for its invalid-lineage floor. The dependency
verifier must reject any Story 2
command/artifact import from Story 1 and any Story 3 import from Story 2 or
Story 1.
Story 2's target-authorized baseline-set capture/signer/verifier and Story 3's
baseline-set persistence remain separately registered non-gate prerequisites;
their command policies and phase allow-lists cannot confer lifecycle authority.
Story 1 alone consumes their exact bytes together with the exact receipt in a
CAS and mints the signed L4 `FindingDeferralDisposition`/
`DeferralLineageState` that may affect the shared predicate. The verifier
must also reject a gate consumer that accepts raw material drift, a host-authored
unrelated label, or a missing/stale/tampered re-attestation as continued
deferral authority.
Exact command names remain subject to normal CLI design review. Atomic/idempotent
persistence, route-receipt validity, non-decay, finite expiry, and fail-closed
fallback are required registered semantics.
Prompt guidance is not sufficient. The contract verifier must reject a new gate
consumer that bypasses the shared predicate, consumes raw/caller assessment data
instead of the registered integrity-state reader, or accepts a candidate route
or advisory historical record as evidence.

The checked-in verifier must use mutation fixtures, not presence-only grep:
inject a new process-registry, command-policy, and phase-allowlist gate consumer
that directly consumes `CandidateRoute`, a standalone `FindingRouteReceipt`, raw
or caller-provided assessment data, an
`InitialProgressBaseline`, an `InitialProgressBaselineSet`, or historical
advisory/candidate data as blocker, pass, or unblock evidence, and independently
inject a consumer that bypasses `isDynamicFindingBlocking`; every mutation must
fail. Dependency
fixtures must permit only `3B -> 3A`, `Story 2 -> 3A`, and
`Story 1 -> {3A,3B,Story 2}`; they separately reject `3A -> 3B`, `3A -> Story 2/1`,
`3B -> Story 2/1`, `Story 2 -> 3B/Story 1`, and every Story 1 reverse edge.
Every mutation fails while that exact edge matrix passes. Enforce entry also registers the
read-only scorecard artifact/command and must refuse when either mutation suite
or dependency contract, including the integrity-state registry contract, is not
green.
The same contract suite mutates `DeferralExpiryPolicy` signature, signer,
digest, version, effective time, V1 constants/ceiling, supersession, and each
disposition binding; an implementation that accepts or silently rebinds any
mutation fails registration/enforce qualification.
It also mutates raw material/story-files bindings, re-attestation signer/hash/
freshness, and every runtime/process-policy/route/canonical dependency digest or
comparison; accepting host narration, a partial dependency set, or any related/
unknown dependency as `unrelated_re_attested` fails qualification.
Baseline mutations remove or flip `gateEvidence`, change its authority/profile,
or disguise an entry/set as a receipt or L4 profile; every registry,
command-policy, and phase-allowlist variant must fail before enforce.
Integrity-state mutations independently alter its signature, signer/verifier,
Finding/Story/assessment IDs and hash, head/material/story-files/scope/runtime/
process-policy bindings, each of the exact nine invalid states, or the signed
state-to-assessment correspondence. They also remove the state, forge a
release/convert/remain transition, or inject a direct registry/command-policy/
phase-allowlist consumer. Every mutation must refuse enforce; only the registered
reader's state may reach the one shared predicate.

The same suite aliases a Story-local display ID, substitutes a `FindingRef.recordId`,
or changes a bound Finding hash/version or `LegacyFindingIdentityBinding`. Every
gate-consumed L4 artifact—`AssessmentIntegrityState`,
`MandatoryRepairClassification`, `MaterialDriftReattestation`,
`DeferralLineageState`, and `FindingDeferralDisposition`—must reject it before
predicate evaluation or CAS.

## 8. Seven-problem ownership matrix

Each class has exactly one primary component and one primary future Story.
Secondary mitigation is named without creating duplicate ownership.

| ID | Historical evidence | Primary component | Primary future Story | Coverage | Falsifiable acceptance result |
| --- | --- | --- | --- | --- | --- |
| P1 | Corpus high-volume Stories; B-cdf6:F-061/F-062/F-065; review-budget handoff | Candidate and Defect Identity | Finding Identity and Historical Lineage | Mitigates classification/repetition cost; cannot eliminate real defects; Dynamic Applicability adds batch/routing and narrowly proven deferral mitigation | On a preregistered Finding-heavy replay set, canonical grouping and batch disposition reduce manual Finding operations by at least 50% with zero missed applicable high/critical defects or false deferrals; existing stall adjudication still triggers normally |
| P2 | B-cdf6:F-067 -> B-META-framework-audit:F-034 | Dynamic Applicability | Dynamic Finding Applicability | Direct | A verified pre-existing defect remains open under its canonical owner, has base/head/no-worsening proof, and does not block the unrelated target Story; scope change makes the old assessment stale |
| P3 | B-cdf6:F-070 / B-META-framework-audit:F-035 | Candidate and Defect Identity | Finding Identity and Historical Lineage | Directly prevents unverified signal from entering the Finding gate; detector accuracy itself remains detector-owned | Replaying the named noise shape creates detector signals/candidates but zero verified Findings until current reproduction; no candidate ID appears in a gate blocker set |
| P4 | B-cdf6:F-056 / B-META-framework-audit:F-032 | Freshness and Supersession | Finding Ledger and Runtime Evidence Integrity | Direct runtime half | Mutating or rebuilding a bound ignored artifact makes the runtime receipt/assessment stale; source-correct/runtime-wrong and source-mismatched/runtime-green campaigns cannot produce an admissible verdict |
| P5 | B-META-framework-audit:F-030/F-031 | Freshness and Supersession | Finding Identity and Historical Lineage | Direct historical half | Canonical lookup returns F-031 as successor while retaining F-030, rejects a cycle/tampered link, and never reports the predecessor as current without a superseded warning |
| P6 | B-META-framework-audit:F-029 | Finding Ledger Integrity | Finding Ledger and Runtime Evidence Integrity | Direct | 100 concurrent unique appends persist exactly 100 unique rows; retrying every request returns the original IDs and creates zero duplicates or lost rows |
| P7 | learning/signature/source-lineage CLI audit | Candidate and Defect Identity | Finding Identity and Historical Lineage | Direct measured retrieval contract; does not promise perfect recall | A versioned gold set reports precision/recall by detector and defect family; superseded rows are excluded; every hit has lineage; historical hits remain non-authoritative and cannot alter the gate |

## 9. Three future Story contracts

### 9.1 Story 1 — Dynamic Finding Applicability

**Objective.** Add target-Story verdict, consume target-authorized route
acceptance, enforce the transient assessment-integrity floor and the distinct
mandatory-repair floor, defer-with-proof with cumulative lineage expiry, batch
disposition, signed freshness binding, and the shared gate predicate. This is
the product-facing Dynamic Finding behavior.

**Included component responsibility.** Own the Dynamic Applicability component
and the assessment-consumer portion of Freshness and Supersession. Consume, but
do not implement, Story 3A ledger and 3B runtime primitives and Story 2 identity/
supersession/route-receipt contracts.

**Problems.** Directly solves P2. Mitigates P1 through batch triage and routing.
Consumes P3/P5/P7 outputs and P4/P6 guarantees; it does not claim to solve those
independently.

**Prerequisites.** For enforce: Story 3A and 3B accepted and merged; Story 2 accepted and
merged; current merged-state combination review green; review assurance floor
unchanged. Read-only observe prototypes may run earlier only if they write no
authoritative artifacts and cannot alter lifecycle output.

**Deliverables.**

- Final `FindingApplicabilityAssessment` schema, signer/verifier, append-only
  reader, and current projection; it consumes the lower/shared immutable
  `FindingAssessmentProposal` rather than re-creating its payload.
- Verifier-derived `AssessmentIntegrityState` and
  `assessmentIntegrityFloorBlocks`, using the exact
  `REQUIRED_ASSESSMENT_INVALID` set and the release/convert/remain transitions;
  it is gate-consumed only through the registered reader and one shared
  predicate, but never persisted as a confirmed repair obligation.
- `MandatoryRepairClassification` classify/close signer, verifier, reader, and
  non-decaying floor; resolve/dismiss handler integration requires fresh
  Red/repro, root-cause, fix, Green, and closure evidence.
- Consumer/adapter for Story 2's non-gate `FindingRouteReceipt` and
  `progress_baseline` entry/set artifacts; validate the receipt's latest-chain
  ID/hash, `finding_route` profile, source-assessment proposal ID/digest,
  freshness, and non-
  revoked/non-superseded state, plus the initial set's exact ID/hash, marker,
  entry completeness, and signatures before consuming them inside the L4
  deferral without redefining its signer, verifier, baseline
  capture, or acceptance command.
- `FindingDeferralDisposition` signer/verifier and eligibility policy, including
  acceptance-impact, current-Story regression, protected-surface, target-owner,
  exact route-receipt CAS binding, expiry, and recheck-trigger validation.
- Signed/versioned `DeferralExpiryPolicy`, canonical-lineage reader/digest, V1
  cumulative 7-day medium/no-renewal and 30-day low/one-renewal limits, hard
  30-day ceiling, signature/authority/effective-time verifier, immutable expiry,
  and non-rebinding policy supersession.
- Read-only consumption of Story 2 `CandidateRoute` records with a hard
  non-authoritative/no-gate boundary.
- Exact verdict/basis/owner/route enums and proof validators.
- Base/head reproduction adapter and no-worsening decision.
- Scope, head, material, story-files, review-run, and runtime-receipt bindings.
- `finding_triage`/assessment inspection and digest-bound batch-manifest apply
  UX whose transaction atomically writes deferral plus manifest/action only
  after revalidating exact existing receipt bytes (final command names chosen
  through normal CLI design review).
- Signed verifier-derived `DeferralLineageState` reader that discovers every
  committed claim from ledger/canonical chains independently of replacement
  assessment presence/content/freshness, and is used as the first safety-floor
  input independently of classification-audit append success.
- L4 `MaterialDriftReattestation` signer/verifier/reader and first-floor
  integration; raw material mismatch is pending/unknown until current signed
  dependency proof or an equivalent new assessment restores authority.
- One `isDynamicFindingBlocking` predicate used by every current consumer.
- L4 command policies, process-fact entries, registry artifacts, and contract
  verifier coverage for both the assessment-integrity projection and the
  mandatory-repair classification without conflating their release contracts.
- Checked-in read-only `finding_rollout_scorecard --json` aggregator owned by
  Story 1. It consumes only Story 2/3 public query contracts, emits the complete
  Section 11 qualification metadata/rows, and supplies the enforce-entry safety
  decision without parsing protected storage.
- Feature state `observe|warn|enforce` and kill switch.

**Required tests.**

- Applicable verified blocker remains blocking.
- Applicable verified critical/high and applicable known/unknown/missing
  protected-surface evaluation create a mandatory floor before severity/round
  decay; changing `effectiveBlockingSeverities` or `isAdvisoryThisRound` cannot
  clear it.
- The adversarial matrix crosses verified open `high` and `critical` at round 3
  with exactly `missing`, `re_attestation_required`, `stale`, `unsigned`,
  `tampered`, `mismatched`, `incomplete`, `expired`, and `unknown` required
  assessments. Every cell remains blocking
  in the pre-round assessment-integrity floor.
- Integrity-state signer/verifier/reader fixtures bind signature, Finding, Story,
  assessment ID/hash, head, material, story-files, scope, runtime evidence, and
  process policy. They reject each nine-state mismatch, missing state, forged
  release/convert/remain transition, raw/caller assessment bypass, and every
  direct consumer outside `isDynamicFindingBlocking`.
- Transition fixtures start from the same missing-assessment state and prove:
  missing -> fresh signed strong `pre_existing_unaffected`, `out_of_scope`,
  `duplicate`, or target-bound `not_reproduced_under_current_witness` releases
  the temporary integrity floor and becomes non-blocking;
  missing -> fresh signed `applicable` leaves the integrity floor and enters the
  mandatory-repair floor; missing -> weakly proven non-applicable or any state
  in `REQUIRED_ASSESSMENT_INVALID` remains blocking. Separate clean-initial
  fresh-valid-strong non-applicable controls produce the same non-blocking result
  as the first transition and prevent a latched or over-tightened floor.
- Missing/stale/tampered classification and a direct resolved/dismissed write
  without a fresh closure remain blocking; closure requires non-empty current
  Red/repro, root-cause, fix, Green, and closure evidence.
- For an open applicable Finding, `missing`, `stale`, `expired`, `exhausted`,
  `tampered`, or unknown-at-boundary `DeferralLineageState` blocks before
  status/severity/round policy even when the `MandatoryRepairClassification` audit append
  fails, is delayed, or loses a race. Exact-boundary, injected write-failure,
  and reader/writer interleaving fixtures must all remain blocking.
- A committed old deferral remains a ledger-derived claimed lineage when there
  is no replacement assessment, when a new assessment omits the old deferral,
  or when scope, story-files, material, runtime, assessment hash, or signature
  drift makes the assessment missing/stale/tampered. Low, round-decayed medium,
  and direct-status-mutation variants all block. Only a fresh strong
  non-applicable/duplicate/disproven superseding proof or complete repair closure
  releases them.
- Fresh strongly proven `pre_existing_unaffected`, `out_of_scope`, `duplicate`,
  or target-bound strong `not_reproduced_under_current_witness` remains outside
  the mandatory-repair floor and releases only a temporary assessment-integrity
  floor. For the current-witness verdict, strong means its signed current
  negative command/runtime witness and command-policy/witness digests plus a
  live accepted owner/route; warn rollback reproduces the exact old predicate.
- A Story 2 route receipt alone produces no gate delta. Story 1 accepts only the
  latest `finding_route` profile with exact ID/hash/source assessment proposal
  ID/digest and
  binds that tuple into `FindingDeferralDisposition.dispositionHash` and the
  manifest action/digest; candidate-profile or mismatched receipts fail closed.
- Receipt creation and deferral apply are separate transactions. The apply CAS
  revalidates latest-chain ID/hash/profile/source, exact initial baseline-set
  ID/hash/bytes, freshness, and no revocation/supersession under one lock, then
  writes deferral plus manifest/action
  atomically. A concurrent receipt successor/revocation or any mismatch writes
  neither artifact; receipt-alone remains legal and non-gate, while
  deferral-alone is rejected.
- Rejected/revoked/expired, wrong source/target/owner/signer/lease/policy,
  tampered, or target-closed Story 2 receipts cannot authorize an L4 deferral.
- Eligible low/medium defer-with-proof remains open/advisory but does not block
  the current Story; it has current reproducible failure evidence, no direct
  acceptance/verificationIntent impact, was not introduced or worsened by the
  Story, touches no protected surface, and has an existing owner/target plus
  valid route receipt. Root cause and Green may remain for the target Story.
- Verified applicable critical/high, or any known/uncertain protected-surface
  risk, cannot be deferred and must complete Red/reproduction -> root cause ->
  fix -> fresh Green in the current Story.
- `pre_existing_unaffected` requires reproducible base/head and no worsening.
- Out-of-scope requires signed scope proof and valid route.
- Duplicate requires a live valid canonical owner.
- File disjointness/history/model confidence alone cannot unblock.
- A required assessment in exactly `missing`, `re_attestation_required`, `stale`,
  `unsigned`, `tampered`, `mismatched`, `incomplete`, `expired`, or `unknown` fails closed for a verified open
  high/critical Finding. Scope-, story-files-, and runtime-stale inputs project
  into that same exact state set rather than creating uncounted aliases.
- Unknown high/critical is never downgraded by applicability.
- Raw `materialHash`-only drift for a claimed deferral first yields
  `pending_re_attestation`/unknown and blocks even with matching
  `storyFilesHash`. A current signed L4 re-attestation restores valid only after
  proving unchanged Story files and unaffected runtime receipts, process policy,
  route, and canonical dependencies. Relevant or unknown runtime/process/route/
  canonical dependency change remains stale; missing/stale/tampered proof and
  host self-classification are rejected.
  The valid unrelated case need not force full re-review.
- Repeated manifest apply is idempotent and returns the original disposition/
  manifest IDs only when the expected exact-receipt tuple is identical.
- Invalid, expired, tampered, partially applied, or trigger-matched claimed
  deferral enters the verifier-derived mandatory floor in enforce and cannot act
  as a waiver; manifest triage fails when a deferred row lacks its exact signed
  route-receipt binding. Warn rollback alone restores the previous predicate.
- V1 derives immutable `firstDeferredAt`/lineage digest across canonical
  supersession and all deferrals. Medium blocks at 7 cumulative days with zero
  renewals; low blocks at 30 cumulative days with at most one renewal.
- Severity flips, target/owner/Story changes, canonical supersession/merge/split,
  or a new deferral ID cannot reset the clock/count. Exact-boundary, clock/
  overdue, gap/cycle/hash tamper, and stricter-severity transitions fail closed
  with exactly-once recall.
- The one permitted low renewal requires a new assessment and Story 2 receipt
  containing a target-authorized typed `ProgressEvidenceBinding` produced after
  the predecessor, current for the same defect/route, and semantically changed
  from the predecessor's kind-specific projection. Positive fixtures allow real
  test-result, delivery-item, or allowed status progress with unchanged source
  bytes. Negative fixtures reject unrelated source/head/material changes, wrong
  defect/route/contract/item/command, no semantic state transition, stale/cross-
  target/reordered/replayed/re-signed-unchanged progress, exhausted count/
  horizon, or an earlier receipt expiry; retries remain idempotent.
- Initial finding-route/deferral fixtures require an atomically persisted,
  target-authorized CLI/server-derived `InitialProgressBaselineSet` with exactly
  one present-or-absent signed baseline for each of the four eligible kinds.
  Deferral/manifest hashes and their CAS bind the exact set ID/hash. Missing,
  tampered, duplicate/wrong kind, wrong defect/route/subject, stale capture, or
  non-target/non-CLI/server baseline fails closed and writes neither artifact.
- The entry and set `progress_baseline` authority markers are signature/hash
  inputs and remain zero-delta advisory records. Removing/flipping
  `gateEvidence`, changing authority/profile, or disguising either as a route
  receipt/L4 artifact fails validation and cannot block, pass, or unblock.
- Renewal derives `predecessorProjectionDigest` from the signed predecessor
  baseline's same-kind entry, never caller input. Positive absent-to-present
  defect-bound test/delivery/status fixtures pass with unchanged code; mere hash
  inequality, no-op/regressive state, unrelated evidence, or missing/tampered/
  wrong-kind/wrong-subject baseline fails closed.
- Policy mutation fixtures reject bad/missing signature, wrong signer authority,
  recomputed-digest mismatch, unsupported version, future/not-yet-effective
  `effectiveAt`, modified 7/30-day constants, renewal limits or hard ceiling,
  and deferral policy-version/digest mismatch. Superseding-policy fixtures prove
  existing rows retain their original policy binding, `firstDeferredAt`, count,
  and cumulative horizon.
- Registry/command-policy/phase-allowlist mutation fixtures reject every newly
  injected gate consumer that reads a candidate, standalone receipt, individual
  progress baseline, baseline set, or historical advisory directly as blocker,
  pass, or unblock evidence, or bypasses the shared predicate.
- The integrated dependency fixture accepts only `3B -> 3A`, `Story 2 -> 3A`,
  and `Story 1 -> Story 2`/`3B`/`3A` APIs. It independently rejects `3A -> 3B`,
  `3A -> Story 2`/`Story 1`, `3B -> Story 2`/`Story 1`, and `Story 2 -> 3B`/
  `Story 1`; Story 1 enforce cannot waive any failed reverse- or cross-edge
  mutation.
- Assessment union fixtures reject every illegal verdict/payload combination,
  missing immutable FindingRef/version/dependency-bundle member, stale/expired
  freshness, and a current-witness verdict used as a freshness value. They prove
  dependency drift invalidates integrity state and no raw assessment bypasses it.
- Applicable disposition-plan union fixtures reject
  `applicable + defer_with_proof` without an exact accepted route and
  `applicable + repair_current` with any route. They reject high/critical or
  known/uncertain protected-surface `defer_with_proof` even with a valid receipt,
  while an otherwise eligible low/medium `applicable + defer_with_proof` final
  assessment with a live exact proposal/receipt tuple constructs and passes to
  the separate deferral eligibility policy. Eligible low/medium
  `applicable + repair_current` remains constructible without a route.
- Proposal/final fixtures require one immutable, receipted
  `FindingAssessmentProposal` lookup before route acceptance or finalization;
  wrong proposal signer/authority/signature, missing lookup, stale/expired
  proposal, route proposal-ID/digest mismatch, or final payload/dependency-bundle
  divergence fails closed. A Story 2 -> Story 1 import mutation also fails.
- Route fixtures require target responsibility ref/hash, live accepting owner,
  valid B-META canonical policy authority where applicable, and an acyclic route
  chain; A->B->A, owner/target change, responsibility closure/supersession, or
  stale receipt revokes and recalls.
- Gate snapshot fixtures cover REVIEW->TEST, TEST->DONE, certification and
  release CAS races over every bound digest and all three evaluation scopes.
  They reject incomplete expiry enumeration (including any active
  `FindingDeferralDisposition` or `DeferralLineageState`), an omitted/forged
  deferral entry or forged-late minimum, `noExpiry` for a nonempty expiring set,
  wrong entry type/ID/hash/`expiresAt`, trusted clock or verifier-policy drift,
  the exact expiry boundary, expiry between preflight and commit, and replay
  against a reused snapshot/clock receipt.
  A target-only strong non-applicable verdict may not release canonical-owner or
  repository-release high/critical aggregation.
- Deterministic scorecard fixtures cover every Section 11 row and assert exact
  numerator, denominator, promotion threshold, rollback threshold, HEAD/window/
  retry/exclusion/hardware/Story-class metadata, and JSON stability. The command
  uses CLI/query contracts only, refuses missing/tampered/incomplete evidence,
  and refuses enforce if any safety threshold or merged prerequisite is unmet.
- Rollback to warn restores the exact previous authoritative predicate.
- Existing review assurance floor, escalation, certification, readiness, and
  convergence surfaces report the same blocker set.

**Non-goals.** No detector/index implementation; no canonical defect inference;
no ledger primitive; no runtime receipt implementation; no historical bulk
assessment; no lab rename; no new convergence breaker; no unowned deferral; no
claim that deferred, routed, or duplicate real issues cease to exist.

### 9.2 Story 2 — Finding Identity and Historical Lineage

**Objective.** Separate raw signal from verified Finding, provide non-gate
target-side candidate routing, establish reviewable semantic identity, resolve
historical supersession, and provide measured, lineage-backed recall.

**Included component responsibility.** Own Candidate and Defect Identity and
the historical supersession/canonical-lookup half of Freshness and
Supersession, including the base target-side route-receipt semantic contract and
candidate-route freshness. Use Story 3's atomic ledger for authoritative
identity/supersession/receipt writes.

**Problems.** Directly addresses P3, P5, and P7. Mitigates P1 by grouping sibling
manifestations and avoiding repeated triage.

**Prerequisites.** Story 3 ledger APIs, unique IDs, idempotent append, and
transaction receipts accepted in merged state before any authoritative
identity/supersession writes. A read-only benchmark prototype may precede Story
3 but remains disposable/non-authoritative.

**Deliverables.**

- `DetectorSignal`, `CandidateFinding`, non-authoritative `CandidateRoute`,
  `CanonicalDefect`, and promotion contracts.
- Shared read-only `FindingAssessmentProposal` verifier/query port over Story
  3A ledger receipts. Story 2 validates proposal ID/digest, exact union payload,
  signer authority/signature, receipt, and currentness before a target may bind
  it in a route; it neither imports nor constructs a Story 1 final assessment.
- Base `FindingRouteReceipt` schema, target-side accept/reject/revoke commands,
  signer/verifier, Story/B-META authority resolver, owner/lease/policy freshness,
  candidate/finding source profiles, and typed target-authorized
  `InitialProgressBaselineSet`/`ProgressEvidenceBinding` with kind-specific
  `ProgressProjection`. Every receipt remains
  `gateEvidence=false`; every baseline entry/set separately carries the signed
  non-gate `progress_baseline` authority marker. Story 1 alone binds exact
  finding-profile receipt and baseline bytes into L4 deferral state.
- Target-authorized CLI/server baseline capture command/handler, canonical
  present/absent projection derivation, per-entry/set signer/verifier, and atomic
  initial finding-route receipt plus baseline-set append through Story 3.
- Independent standalone-receipt append through Story 3 and CandidateRoute CAS
  against an exact existing receipt; neither operation imports a Story 1
  artifact or command.
- Canonical defect identity with `rootCauseState=unknown|hypothesized|confirmed`
  and optional root cause; trigger/reproduction/affected-contract evidence may
  establish identity before cause is known.
- Stable access through Finding/store/CLI ports; no direct protected-storage
  parsing.
- Confirmed versus suggested identity and source-lineage separation.
- `FindingSupersession`, `CanonicalDefectSupersession`, cycle detection, tamper
  checks, and canonical-current lookup.
- Versioned historical index keyed by exact paths, symbols, contracts,
  canonical defect ID, source lineage, and outcome.
- Candidate/deferred-route recall keyed by candidate or canonical defect, target
  Story/B-META gap, owner, affected contracts, scope/hash/runtime bindings,
  expiry, and recheck triggers. Historical route rows produce
  `CandidateFinding` only.
- Suspected-candidate routing requires uncertainty, evidence, a live existing
  target/owner, and an accepted route receipt without requiring promotion,
  root-cause analysis, or Green evidence.
- Gold-set benchmark and recall/precision report by detector/family.
- Stable read-only query contract for candidate/identity/route authority,
  supersession, recall, and progress-projection scorecard inputs; every row is
  signed/digest-bound and consumable by Story 1 without protected-storage
  parsing.
- Candidate inspection, merge, disprove, and reviewer-confirmed promotion UX.

**Required tests.**

- DetectorSignal/CandidateFinding can never appear in lifecycle blocker input.
- CandidateRoute is rejected when uncertainty, evidence, existing owner/target,
  or route receipt is missing; a valid route remains non-authoritative and
  produces no lifecycle transition delta.
- CandidateRoute requires `evidenceAuthority.profile='candidate_route'`; a
  finding-profile receipt cannot be substituted even when other fields match.
- Target acceptance may persist a standalone signed receipt atomically before
  any CandidateRoute exists; receipt-alone has zero lifecycle delta. A later
  CandidateRoute CAS binds exact latest-chain ID/hash/profile/source bytes and
  fails without changing either record after a concurrent revocation,
  supersession, expiry, target-state change, or byte/hash mismatch.
- Initial `finding_route` acceptance persists exactly four canonical signed
  baseline entries with the receipt in one transaction. Present/absent field
  exclusivity, canonical absence digest, kind uniqueness/completeness, target
  authority, CLI/server producer, defect/route/contract/item/command subject,
  capture freshness, and entry/set hashes/signatures are mutation-tested.
- Entry and set hashes/signatures cover the exact non-gate
  `progress_baseline` authority marker. Removing/flipping `gateEvidence`, changing
  authority/profile, or masquerading as `FindingRouteReceipt`/L4 fails; direct
  lifecycle consumption has zero delta and fails registry/policy/allow-list
  mutation contracts.
- Existing-Story acceptance succeeds only for its target-authorized owner/
  command-policy actor; B-META acceptance succeeds only for canonical audit/
  main-write authority. A source-Story author cannot self-sign either.
- Wrong source kind/ID/hash/Story, target, target scope/state, owner, signer,
  lease/policy, rejection/revocation, expiry, tamper, or target closure rejects
  the receipt for a CandidateRoute. A failed later route CAS writes no route but
  may leave the already committed standalone non-gate receipt intact.
- Recall consumes only a fresh accepted Story 2 route receipt; rejected,
  revoked, expired, wrong-owner/signer/target, or tampered receipts remain
  historical context and cannot generate an authoritative assessment.
- Story 2 builds and tests without importing any Story 1 handler, artifact, or
  command; a dependency mutation that adds any such import fails, and its
  receipts have zero lifecycle transition delta.
- `ProgressEvidenceBinding` rejects a missing/invalid target-authorized nested
  signature, pre-predecessor or stale `producedAt`, wrong target/scope/head/
  material authority snapshot, wrong predecessor projection/baseline,
  canonical defect, route, affected contract, acceptance/checklist item,
  test command/selector/outcome, or allowed status transition; it rejects
  cross-target reuse, unrelated source/head/material movement, non-canonical
  reorder, replay, and re-signing without semantic projection change. Positive
  tests accept defect-bound test/delivery/status progress with unchanged code.
- Baseline lookup returns the exact same-kind signed predecessor digest to Story
  1; it rejects caller-supplied replacement, missing/tampered/wrong-kind/wrong-
  subject baselines. An absent initial test/delivery/status projection may later
  become a defect-bound present projection, but unequal hashes alone never prove
  semantic progress.
- Registry/command-policy/phase-allowlist mutations that make a gate consume
  CandidateRoute, standalone receipt, or historical advisory data directly fail
  the shared contract verifier even though Story 2 itself remains non-gate.
- Scorecard query fixtures return deterministic complete signed rows, reject
  tamper/incomplete data, and expose no protected-storage path or parser.
- Promotion requires current source/reproduction evidence and eligible reviewer
  authority.
- Same canonical source is deduped as provenance but not assumed to be the same
  semantic defect.
- Same semantic defect can link independent sources only after confirmation.
- `rootCauseState=unknown` forbids a fabricated root-cause string yet permits
  identity from trigger/reproduction/affected contract; later cause correction
  is a signed `CanonicalDefectSupersession` and preserves the predecessor;
  cycles, missing nodes, or hash/signature mismatch are rejected.
- `hypothesized`/`confirmed` require a non-empty cause and evidence; an empty
  identity evidence set is rejected in every state.
- F-030/F-031-shaped chain returns successor, retains predecessor, rejects
  cycles, missing nodes, signature mismatch, and contradictory successors.
- Historical DONE/outcome/tag/playbook never blocks or unblocks a current Story.
- Starting/creating the routed target, matching its scope or affected contract,
  severity escalation, owner invalidation, target closure without a Green fix,
  expiry, or relevant hash/runtime drift recalls the routed candidate/defect
  exactly once as a candidate; only a fresh promotion permits a new current
  assessment.
- A historical route/deferral alone cannot enter a lifecycle blocker set or
  recreate an assessment.
- Exact package/symbol/path lookup outperforms coarse tag-only baseline on the
  preregistered set without lowering high/critical safety.

**Non-goals.** No applicability gate; no L4 deferral or route-receipt gate
projection; no runtime artifact receipts; no direct Finding resolution; no
claim of perfect recall; no embeddings/remote index without separate evidence
and scope; no bulk rewrite of legacy Findings.

### 9.3 Story 3 — Finding Ledger and Runtime Evidence Integrity

**Objective.** Prove that every Finding-system mutation is durable and
exactly-once, and that executed runtime artifacts are bound to their source and
command before later components consume them.

**Included component responsibility.** Own Finding Ledger Integrity and the
runtime-receipt/artifact-invalidation half of Freshness and Supersession.

**Problems.** Directly addresses P6 and the runtime half of P4. It merely
mitigates P1 by preventing persistence-retry and stale-runtime rework; it does
not own convergence or reduce genuine defect repair. It supplies the safety
foundation required by every later Story.

**Prerequisites.** None of the other two Dynamic Finding implementation Stories.
It must audit and reuse existing per-Story Finding locks, main/B-META locks,
process-event append locks, build locks, and store transaction patterns rather
than adding an uncoordinated lock tree.

**Internal milestones (one Story, not new Stories).** **3A Ledger Integrity**
ships the epoch/capability/fenced-writer transaction, append-only IDs,
idempotency and recovery contract. **3B Runtime Evidence Integrity** consumes
3A to ship content-addressed execution receipts and artifact invalidation. 3A
is the prerequisite for Story 2 authoritative identity/supersession and 3B;
3A + 3B + Story 2 are prerequisites for Story 1 enforce. Story 2 read-only and
Story 1 observe prototypes may run in parallel, but no authoritative or gate
path may bypass that order.

**Deliverables.**

- Shared atomic append/transaction primitive for Finding, candidate route,
  assessment proposal, final assessment, mandatory-repair, expiry-policy,
  deferral, supersession, route,
  initial progress baseline set, material-drift re-attestation, manifest, and
  receipt records.
- Schema-neutral transaction snapshot/CAS primitive that can commit a standalone
  receipt, or later hold the lock while a caller compares exact referenced
  record ID/hash/current-chain bytes and conditionally commits multiple records;
  Story 3 does not interpret route profiles or assessment semantics.
- Unique ID allocator independent of mutable array length.
- Idempotency key, expected-prior digest/CAS behavior, durable commit receipt,
  replay result, and explicit conflict.
- Crash/interruption recovery and stale-lock diagnostics.
- A fenced writer/fault model: shared canonical local FS across local processes
  and worktrees, crash/kill/retry/stale lock/partial-temp-write recovery, and
  acknowledged-fsync/atomic-rename power-loss boundary; refuse unsupported
  multi-host/NFS or corruption assumptions absent a new adapter contract.
- `RuntimeEvidenceReceipt` signer/verifier and build/execution adapter.
- Artifact-digest/source-head/environment/command/output binding.
- Content-addressed command, output, redacted/allowlisted environment and
  artifact-manifest blobs; canonicalization, realpath, toolchain, key trust,
  rotation/revocation and freshness verification.
- Build-in-progress refusal and post-run artifact-stability check.
- Process-fact registration for atomic persistence and gate-eligible runtime
  evidence.
- Stable read-only query contract for ledger/CAS/idempotency/runtime scorecard
  inputs, with signed row digests and no exposure of protected storage paths.

**Required tests.**

- 100 concurrent unique Finding appends -> exactly 100 unique durable rows.
- Concurrent/replayed/crashed `append_legacy_identity_binding` first reads use
  the same idempotency/CAS receipt path: one immutable legacy tuple/hash maps to
  exactly one record ID; collision, changed hash, or a second record ID fails
  closed without rewriting the legacy Finding.
- Concurrent mixed Finding/candidate-route/assessment/mandatory-repair/
  expiry-policy/deferral/route/baseline-set/material-re-attestation/manifest
  writes lose nothing and preserve referential integrity.
- `append_assessment_proposal` atomically persists one immutable proposal and
  one non-recursive `FindingLedgerReceipt`; idempotent retry returns the exact
  proposal/receipt IDs. A wrong signer/signature/authority, altered exact-union
  payload, missing receipt lookup, stale/expired proposal, or proposal/final
  divergence is rejected before Story 2 route acceptance or Story 1 finalization.
- Mandatory-repair classify/close and expiry-policy records are append-only,
  unique, idempotent, and never half-visible with their manifest references.
- Story 2 can atomically append a standalone prevalidated candidate/renewal
  target receipt, or an initial finding-route receipt plus its baseline set with
  all four entries; crash/retry yields the complete intended transaction or
  none, and persisted receipt/baseline bytes alone have no gate authority.
- Persistence preserves each entry/set non-gate authority marker byte-for-byte.
  Marker removal/flip/profile substitution, or registering persisted baseline
  bytes as receipt/L4 blocker, pass, or unblock evidence, fails mutation tests;
  Story 3 never upgrades persistence integrity into semantic gate authority.
- A later candidate-route transaction CAS-checks an existing exact receipt and
  writes only the route; a failure leaves the standalone receipt intact and no
  half route visible.
- A later Story 1 transaction CAS-checks an existing exact receipt and its
  already persisted exact initial baseline set, then writes deferral plus
  manifest/action atomically; crash, conflict, changed chain head/baseline, or caller-verifier
  refusal writes neither, and retry returns the same deferral/manifest IDs
  without rewriting the receipt/baseline.
- Concurrent revoke/supersede versus deferral apply has a deterministic winner:
  the apply observes either the prior latest receipt and commits before its
  successor, or the successor and aborts. No serialization permits a deferral
  bound to a non-latest receipt at commit time.
- Replaying all 100 idempotency keys -> same IDs, zero new rows.
- Two writers with a stale expected digest receive an explicit conflict; neither
  silently overwrites the other.
- Kill process between prepare/commit steps -> deterministic recovery with no
  half-visible row.
- Build/output mutation before, during, and after execution invalidates or
  refuses the receipt as specified.
- Receipt tamper, wrong source HEAD, changed command, changed artifact bytes,
  and changed environment are rejected.
- Concurrent/partial initial receipt-baseline persistence, wrong expected
  baseline ID/hash, missing one of four entries, or baseline byte mutation is
  rejected with no half-visible authoritative bundle. Re-attestation records are
  likewise unique/idempotent and exact-byte receipted; persistence never decides
  whether drift is unrelated.
- No nested-lock deadlock with current Finding and B-META write paths.
- Story 3 builds with no import from Story 2 or Story 1; separate dependency
  mutations adding either forbidden import fail while schema-neutral callback/
  CAS consumers continue to build.
- Registry/command-policy/phase-allowlist mutation fixtures still fail when a
  new gate consumer bypasses the shared predicate or treats a persisted
  standalone receipt/candidate/historical advisory as semantic gate evidence;
  persistence authority cannot be promoted by registration.
- Scorecard query fixtures deterministically report exact atomicity/CAS/runtime
  numerator and denominator inputs, reject missing/tampered/incomplete rows, and
  are consumed only through the public query contract.

**Non-goals.** No detector classification, canonical defect judgment,
applicability verdict, target-authority/routing decision, route semantic signer
or verifier, expiry-policy judgment, historical recall, lifecycle gate
enforcement, lab rename, or claim that persistence proves semantic acceptance.

### 9.4 Dependency DAG and reconciliation

```text
Story 3A: Ledger Integrity
   |\
   | \-> Story 3B: Runtime Evidence Integrity -\
   v                                         |
Story 2: Finding Identity and Historical Lineage
   |    canonical ID + non-gate route/baseline|
   v                                         v
Story 1: Dynamic Finding Applicability ------> enforce gate
```

Safe sequence:

1. Implement and accept Story 3A.
2. Implement and accept Story 3B on the ledger foundation. Story 2 and Story 1
   may prototype read-only work against 3A/3B public query contracts only.
3. Implement and accept Story 2's single authoritative identity/lineage contract,
   including its
   target-side non-gate route and initial-baseline signer/verifier, standalone
   receipt transaction, and atomic initial receipt-plus-baseline transaction,
   with no Story 1 dependency.
4. Implement Story 1 as a consumer of Story 2 identity/receipt APIs; keep it
   responsible for the later exact-receipt CAS that atomically creates the
   deferral plus manifest/action, and keep it observe/warn until merged-state
   review proves Story 3A + Story 3B + Story 2 + Story 1 together; then consider enforce.

Component-to-Story reconciliation:

| Component | Delivery owner |
| --- | --- |
| Finding Ledger Integrity | Story 3 |
| Candidate and Defect Identity | Story 2 |
| Dynamic Applicability | Story 1 |
| Freshness and Supersession | Story 2: historical supersession/recall, non-gate route freshness, target-authorized initial progress baselines and typed progress binding; Story 3: runtime receipts and schema-neutral atomic/CAS baseline/re-attestation bytes; Story 1: assessment, ledger-derived lineage floor, gate-consumed material re-attestation, exact receipt/baseline-to-deferral L4 binding, and cumulative deferral-lineage freshness |

No component or failure class is orphaned. No failure class has two primary
owners. The complete program covers P1-P7 at the structural level described in
the matrix; Dynamic Applicability alone does not.

Parallel implementation does not relax ordering: branches may prototype
non-gating work concurrently, but any process-framework deliveries must receive
a merged-state combination review before Story 1 enforce. No Story may lower
the existing review assurance floor to make the combination pass.
The dependency graph is acyclic: Story 3A imports neither Story 2 nor Story 1;
Story 3B imports 3A only; Story 2 imports 3A persistence/query contracts and
never Story 1; Story 1 imports Story 2 identity/route/query semantics and 3B runtime/
ledger/query contracts. Checked-in dependency mutation fixtures must reject each
forbidden reverse import independently.

## 10. Migration, rollout, and rollback

### 10.1 Legacy migration

- Preserve every historical Finding byte/record and its existing signature.
- Do not add assessments to all 2,273 point-in-time rows.
- Build derived candidate/index material through stable readers and keep it
  non-authoritative.
- Assess a historical Finding lazily only when a target Story retrieves and
  currently revalidates it.
- Legacy missing `evidenceState` continues to project to verified, matching the
  current CLI/gate compatibility rule.
- On first read or ledger-mediated backfill, append a signed
  `LegacyFindingIdentityBinding` from immutable `{storyId,findingId,findingHash}`
  to `recordId` through atomic `append_legacy_identity_binding`; do not rewrite old Finding bytes. A collision, changed legacy
  hash, or two record IDs for one legacy tuple fails closed. The human Finding ID
  remains only the Story-local display ID. Its tuple/hash CAS and idempotency key
  make concurrent first-read/backfill, retry, and crash recovery return one
  receipted record ID or fail closed. Only `FindingLedgerReceipt` itself is
  exempt from receipt recursion.
- Legacy missing assessment projects to unknown; it cannot downgrade an old
  blocker.
- Legacy text that says "deferred", `accepted_risk`, or `superseded` is not a
  `FindingDeferralDisposition`; only the new signed structure can affect current
  triage, and no historical row is rewritten to manufacture one.
- Legacy routing prose is not a `FindingRouteReceipt`, and legacy identity prose
  never implies a confirmed root cause. Derived canonical records start with
  `rootCauseState='unknown'` unless evidence supports a stronger state.
- Resolve supersession chains during lookup, while preserving predecessor
  access and audit history.
- All new records are additive and versioned. Older binaries can ignore them
  while the feature remains observe/warn.

### 10.2 Rollout states

| State | Entry criteria | Permitted writes | Gate authority | Operator-visible output | Exit / rollback |
| --- | --- | --- | --- | --- | --- |
| `observe` | Read-only classifier/index prototype passes structural tests | None; stdout/report only. Benchmark artifacts, if explicitly exported outside lifecycle state, remain non-authoritative. | Existing `isFindingBlocking` only | Candidate groups/routes, predicted mandatory floors, proposed verdicts/deferrals, target-authority/receipt gaps, expiry-policy violations, high/critical closure gaps, predicted blocker delta, latency | Exit to warn after labeled replay shows no safety violation and 3A/Story 2 dependencies needed by persisted advice are ready; kill switch simply disables output |
| `warn` | Story 3A ledger persistence/query contract accepted; Story 2 candidate/identity/supersession plus non-gate route/query semantics accepted; observe qualification thresholds met | Story 2 may append standalone signed target route receipts, atomically append an initial receipt with its four-kind baseline set, and later CAS-bound candidate routes; Story 1 appends only non-authoritative triage/mandatory/deferral/re-attestation proposals; no new L4 artifact affects lifecycle | Existing predicate only; every route receipt and every baseline entry/set carries and verifies its non-gate marker | Old blocker set plus proposed exact receipt/baseline tuple and CAS result, ledger-derived claimed-lineage floor, material-drift pending/re-attestation result, policy/progress projection results, protected-surface/closure gaps, and read-only scorecard JSON/refusal reasons | Return to observe on data/persistence defect; advance only after merged-state qualification and complete scorecard evidence |
| `enforce` | Story 3A + Story 3B + Story 2 + Story 1 accepted in the acyclic merged order; signed current-material assessment; runtime receipt; assessment-integrity and mandatory-repair process-fact contracts; Story 2 target-authorized receipt and signed complete non-gate initial baseline set; exact receipt/baseline CAS; baseline authority-marker and direct-consumer mutations green; gate-consumed material-drift re-attestation contract; authentic effective V1 policy; legacy compatibility; gate/dependency mutations and adversarial/rollback tests green; complete `finding_rollout_scorecard --json` passes every safety threshold, qualification window, and merged prerequisite | Atomic/idempotent standalone non-gate receipt/candidate route and atomic initial receipt-plus-baseline set; separate Story 1 CAS atomically writes L4 deferral plus manifest/action; expiry policy, re-attestation, and audit records remain append-only | Ledger-derived claimed-lineage invalid or pending-re-attestation state first, then assessment-integrity floor, then mandatory-repair classification floor, then ordinary shared-predicate policy; route receipts/candidates/baseline entries/sets alone remain non-authoritative and only Story 1's signed L4 disposition/lineage projection can consume them into gate state | Effective integrity/mandatory/blocker sets, integrity release-or-convert transition, repair closure/release chain, expected/current receipt and baseline tuple with CAS result, policy binding, kind-specific progress projection, signed material-drift re-attestation state, scorecard evidence/refusal, candidate recall, freshness, kill switch | Any safety threshold, scorecard evidence, baseline marker/direct-consumer mutation, registry/dependency mutation, or merged-prerequisite failure immediately refuses/ends enforce and restores previous predicate; records remain append-only |

Observe and warn may render only proposed/diagnostic integrity conclusions; they
must not mint or consume `AssessmentIntegrityState` as a lifecycle authority.
Enforce additionally requires the signature-valid `AssessmentIntegrityState`
signer/verifier/reader, its L4 artifact and required semantics in
`PROCESS_FACT_LEVELS`, `COMMAND_POLICIES`, and the process-fact registry, and
the contract-verifier proof that the registered state reaches every consumer only
through `isDynamicFindingBlocking`. Any integrity-state signature, binding,
state/assessment correspondence, direct-consumer, or registry mutation refuses
or ends enforce and restores the previous predicate.

The feature-state downgrade is a policy switch, not a data rollback. Disabling
enforce must restore the previous authoritative blocker predicate and treat all
assessment/candidate/mandatory-repair/route-receipt/deferral records as advisory.
It must not delete Findings, assessments, classifications, deferrals, routes,
receipts, policies, supersession links, or audit lineage.
Re-enabling requires freshness evaluation; no old assessment or deferral is
silently rebound.

### 10.3 Required rollback proof

- Enforce -> warn produces the same transition decision as the pre-feature
  predicate for a frozen fixture corpus.
- In enforce, mandatory critical/high/protected-surface fixtures remain blocking
  after severity/round decay and direct status mutation; in warn the same corpus
  returns exactly to the old predicate.
- Advisory records never become evidence after downgrade.
- Invalid or partial suspected-candidate routes remain non-authoritative and
  cannot create, clear, or restore a blocker.
- Repeated manifest apply remains idempotent across the state change.
- Receipt-alone remains non-gate across state changes. Wrong ID/hash/profile/
  source assessment, wrong or incomplete initial baseline set, concurrent
  receipt revocation/supersession, or CAS conflict leaves both deferral and
  manifest/action absent; no rollback path treats a receipt/baseline bundle or
  deferral-alone row as authoritative.
- Each initial baseline entry/set remains non-gate across state changes. Removing
  or flipping its signed marker, changing its profile/authority, disguising it as
  a receipt/L4 record, or wiring it directly into any blocker/pass/unblock
  consumer fails closed; only Story 1's exact-CAS-derived signed L4 disposition/
  lineage state may affect the predicate.
- Scope, Story-owned material, and runtime artifact changes invalidate exactly
  the dependent assessments and deferrals.
- A committed deferral remains ledger-derived claimed lineage after replacement
  assessment deletion, omission, tamper, or scope/story-files/material/runtime
  drift; none can reach `not_present` or bypass the first floor.
- In enforce, an invalid, expired, ownerless, partially applied, or
  trigger-matched claimed deferral enters the verifier-derived mandatory floor
  and is never converted into a waiver. After rollback to warn, only the
  previous predicate is authoritative.
- Wrong-authority/revoked route receipts and V1 cumulative boundary/over-count
  deferrals fail closed; renewal creates new assessment/Story 2 acceptance/
  deferral rows and never mutates or resets the predecessor lineage.
- Invalid signature/signer/digest/version/effective time/V1 constants/hard
  ceiling or deferral-policy mismatch fails closed. Policy supersession neither
  rebinds an existing disposition nor resets its lineage clock/count/horizon.
- Severity flip, target/Story/canonical change, supersession/merge/split, chain
  tamper, or unchanged/missing progress cannot reset `firstDeferredAt` or evade
  mandatory repair.
- At the exact expiry/horizon boundary, and under injected classification-write
  failure or reader/writer race, invalid `DeferralLineageState` remains the first
  blocking floor. Renewal derives its predecessor projection only from the
  signed same-kind initial baseline. Missing/tampered/wrong-subject baselines,
  unrelated source/head/material movement, wrong defect/route/item/command,
  stale/cross-target/reordered/replayed/re-signed-no-op or regressive progress
  cannot renew authority, while an initial absent baseline followed by genuine
  defect-bound test/delivery/status progress with unchanged code remains
  representable.
- Scorecard missing/tampered/incomplete input, any row rollback threshold, any
  unqualified window, forbidden gate-consumer/dependency mutation, or unmerged
  prerequisite produces explicit enforce refusal.
- Any raw material-only drift on a claimed lineage is first-floor
  `pending_re_attestation`, even with unchanged Story files. It returns to valid
  only through current signed L4 proof that every bound runtime/process/route/
  canonical dependency is unaffected; host self-classification and missing,
  stale, tampered, related, or unknown proof remain blocking.
- Rollback/recovery performs no historical record rewrite or deletion.

## 11. Rollout scorecard

Every report must record feature state, date range, repository HEAD(s), Story
classes sampled, detector versions, retry policy, exclusions, and hardware for
latency. Review lane/run counts must not be called review rounds. Time saving is
reported in four separate buckets:

```text
classifier compute cost
+ reviewer triage cost
+ genuine defect repair cost
+ review convergence cost
```

The program may claim reductions in compute/triage/convergence only from their
own measurements. Genuine applicable-defect repair time is reported, not
credited as a Dynamic Finding saving.

Story 1 owns the checked-in read-only
`finding_rollout_scorecard --json` aggregator and its enforce-refusal result.
Story 2 provides signed identity/candidate/route/progress query rows; Story 3
provides signed ledger/CAS/runtime query rows. The aggregator calls those public
CLI/query contracts only and must never parse protected storage. Its stable JSON
contains each table row's exact numerator, denominator, observed value,
promotion threshold, rollback threshold, pass/refuse reason, and evidence
digests, plus feature state, date/window, repository HEADs, Story classes,
detector versions, retries, exclusions, and latency hardware. Before that
command exists, the CLI-only corpus procedure in section 3 is the reproducible
baseline, not an enforce artifact.

Checked-in deterministic fixtures must exercise every table row, exact boundary,
empty denominator policy, and rollback condition. Missing, tampered,
incomplete, non-current, or internally inconsistent evidence makes the command
return refusal rather than omit a row or assume zero. Warn -> enforce is refused
when any safety threshold, qualification window, 3A/3B/Story 2 merged prerequisite,
dependency mutation suite, or merged-state combination review is not green.
A zero denominator is emitted as `observed=null,status='insufficient_evidence'`
and cannot vacuously satisfy a safety threshold; descriptive-only rows retain
their explicit non-promotion semantics.

For every zero-event safety row the scorecard reports `observed=0`, its sampled
`N`, high and critical strata separately, and a one-sided confidence upper bound
under the declared method. It never calls an observed zero the true risk zero.

Qualification window for warn -> enforce: at least 20 Finding-bearing Stories
and 200 independently adjudicated candidate/assessment cases over at least 30
days, including every proposed suspected-candidate route, every proposed
mandatory-repair classification/closure and route receipt, every proposed
deferral/renewal, every high/critical proposed non-blocking verdict, and a
targeted adversarial suite. Promotion requires all safety thresholds and the
merged-state dependency review.

| Metric | Numerator / denominator | Collection | Promotion threshold | Rollback threshold |
| --- | --- | --- | --- | --- |
| False non-blocking high/critical | Adjudicated high/critical verdicts classified non-blocking by the system but applicable by independent qualification / all system-proposed non-blocking high/critical verdicts | Scorecard join of signed proposal, reviewer adjudication, and current repro receipt | **0**, including adversarial set | Any one event |
| Stale/tampered rejection | Stale/tampered/mismatched test cases rejected / all injected stale/tampered/mismatched cases | Deterministic negative suite plus receipt-verifier events | 100% | Any accepted case |
| Required-assessment integrity fail-closed | Signature-valid `AssessmentIntegrityState` rows for verified open high/critical cases in `REQUIRED_ASSESSMENT_INVALID` that remain blocked by the assessment-integrity floor / all injected verified open high/critical required-assessment cases in exactly `{missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown}`; fresh-valid controls are reported separately and excluded from this denominator | Shared-predicate and live-warn Cartesian fixtures for both severities at round 3 across all nine states; signer/verifier/reader and story/finding/assessment/head/material/story-files/scope/runtime/process-policy binding mutations; missing-state, state/assessment mismatch, raw/caller bypass, and direct-consumer registry mutations; transition fixtures for missing -> fresh-strong-non-applicable (including target-bound strong `not_reproduced_under_current_witness`) release, missing -> fresh-applicable conversion to mandatory repair, and missing -> weak/invalid non-applicable continued blocking; separate clean-initial fresh-valid-strong `pre_existing_unaffected`/`out_of_scope`/`duplicate`/target-bound `not_reproduced_under_current_witness` controls | 100% of the exact invalid-set denominator blocks; 100% of valid strong controls, including current-witness controls, release or start outside the integrity floor; 100% of fresh applicable transitions enter mandatory repair; 100% of state/binding/registry mutations refuse enforce | Any invalid-set cell becomes non-blocking, any missing/forged/mismatched state or raw/caller/direct-consumer bypass is accepted, any weak/invalid non-applicable transition releases, any fresh applicable transition fails to enter mandatory repair, or any clean/transitioned fresh-valid-strong control is rejected |
| Mandatory-repair floor and closure integrity | Applicable high/critical and known/unknown protected-surface obligations that remain blocked until complete Red/root-cause/fix/Green closure, plus ledger-derived claimed lineages with missing/stale/expired/exhausted/tampered/unknown state that remain blocked until their separate strong lineage release or complete repair closure / all injected confirmed mandatory-repair and claimed-lineage cases | Shared-predicate, ledger claim scan, no-replacement/omitted-lineage, scope/story-files/material/runtime drift, exact-boundary clock, classification-write failure, reader/writer race, stale/tamper, lineage strong-release, and mandatory-repair closure mutation suite | 100%; zero assessment-omission, direct-status, audit-write, or lineage bypasses; zero confirmed repair obligation released without complete closure | Any claimed lineage erased by assessment state, any confirmed mandatory-repair obligation accepted with only a non-applicable verdict, any decayed/bypassed floor, any audit-write failure that opens the gate, or any weak/incomplete lineage release or repair closure accepted |
| Non-blocking classification precision | Independently confirmed correct non-blocking verdicts / all reviewed non-blocking verdicts | Stratified reviewer gold set; disclose severity and verdict mix | >=98% overall and 100% high/critical safety | <98% overall or any high/critical safety miss |
| Candidate-to-verified conversion | Candidates promoted to verified Findings / all terminally adjudicated candidates, per detector/version | Candidate ledger and promotion receipts | Descriptive, not maximized; each detector preregisters a baseline band before warn | Absolute drift >10 percentage points without an explained corpus/version change pauses promotion |
| Canonical root-cause honesty | Canonical identities whose `rootCauseState` and optional value match reviewed evidence / all independently reviewed canonical identities | Identity gold set plus supersession audit | 100%; unknown cause remains representable | Any fabricated cause, cause present with `unknown`, or in-place cause rewrite |
| Duplicate/routed disposition accuracy | Correct canonical duplicate or valid routed-owner decisions / all independently reviewed duplicate/routed decisions | Manifest, canonical lookup, route target validation | >=98%; 100% of real high/critical non-blocking issues have a valid owner | Any unowned high/critical or <98% |
| Suspected-candidate route completeness and isolation | Low/medium candidate routes with explicit uncertainty, current evidence, live existing target/owner, signed receipt, expiry/triggers, and zero gate delta / all proposed suspected routes | Candidate/route ledger join, target validation, and frozen-gate before/after comparison | 100% complete and 100% zero gate delta; no promotion/root-cause/Green prerequisite | Any incomplete route accepted, any candidate promoted implicitly, or any gate delta |
| Route-receipt authority, isolation, and freshness | Story 2 receipts accepted by the exact target-authorized owner/policy actor with matching source/target/hash/scope and live lease/policy, while producing zero standalone gate delta / all acceptance proposals and adversarial receipts | Story 2 authority lookup/command log/signature-freshness suite plus Story 1 exact ID/hash/profile/source integration and frozen-gate comparison | 100% valid, 100% zero standalone gate delta; source Story self-sign rejected | Any wrong signer/owner/target/hash, stale/closed target, revocation, tamper, standalone gate delta, or Story 2 -> Story 1 import |
| Initial progress-baseline integrity and isolation | Initial finding-route receipts with one target-authorized CLI/server-derived signed present-or-absent baseline for each eligible progress kind, exact signed non-gate authority marker, subject/route/defect binding, and zero standalone gate delta / all initial finding-route proposals and injected baseline/consumer mutations | Story 2 baseline capture/verifier rows joined to Story 3 atomic receipt-plus-set commit; mutate kind/subject/state/digest/authority/producer/signature, remove/flip marker fields, impersonate receipt/L4 profiles, and inject registry/command-policy/phase-allowlist blocker/pass/unblock consumers | 100% complete/valid, 100% marker mutation rejection, and 100% zero direct gate delta; only exact-CAS-derived Story 1 L4 state may affect the gate | Any missing/duplicate/wrong-kind or wrong-subject entry, fabricated caller baseline, partial receipt/set, invalid signature/hash/marker, profile impersonation, or direct baseline gate dependency accepted |
| Exact receipt/baseline CAS and deferral atomicity | Applies whose existing latest receipt exact ID/hash/profile/source-assessment proposal ID/digest and baseline-set ID/hash/bytes are revalidated with freshness and no revocation/supersession, then deferral plus manifest/action commit together / all deferral applies and injected races | Story 1 transaction/CAS log joined to immutable Story 2 receipt/baseline chain and Story 3 commit receipt; mutate every expected tuple field and interleave revoke/supersede/baseline change | 100% valid commits; 100% mismatches/races write neither deferral nor manifest/action; receipt/baseline records alone remain legal/non-gate | Any stale/non-latest tuple or wrong baseline accepted, any partial deferral/manifest commit, any failed CAS mutation, or any receipt/baseline-alone gate delta |
| Deferral route completeness | Deferred rows with a live existing target, owner, exact accepted signed route receipt tuple, expiry, and complete recheck triggers / all proposed deferred rows | Deferral/manifest atomic ledger join plus latest receipt-chain and target existence/owner validation | 100% | Any orphan, missing/mismatched receipt, deferral-alone/manifest-alone commit, or closed-unfixed target accepted as valid |
| False deferral | Independently adjudicated deferred rows that require current repair or touch a protected surface / all system-proposed deferrals | Current reproducible failure evidence, acceptance/verificationIntent diff, introduced/worsened analysis, protected-surface campaign, and independent disposition review | **0**; critical/high proposals are mechanically ineligible; root cause may remain for the target Story | Any one event or any protected-surface risk deferred |
| Stale/overdue/reopened deferral handling | Triggered, expired, owner-invalid, or target-closed-unfixed deferrals recalled as candidates and made non-authoritative / all such deferrals injected or observed | Freshness/expiry evaluator events joined to candidate recall and gate decisions | 100%, exactly-once candidate recall per trigger set | Any stale/overdue row remains non-blocking, any missed recall, or duplicate recall changes gate state |
| Deferral expiry-policy integrity | Proposals bound to an authentic currently effective policy with exact supported version/digest/signer, V1 7/30-day constants, renewal limits and hard ceiling, while existing rows retain original policy/lineage under supersession / all deferral proposals plus policy mutations/supersessions | Policy signature/authority/digest/version/time/constant mutation suite joined to deferral binding and lineage reader | 100% valid binding and 100% mutation rejection | Any bad/not-yet-effective/mismatched policy accepted, or policy supersession rebinds/reset an existing row |
| Deferral lineage horizon and renewal compliance | Canonical lineages with correct immutable `firstDeferredAt`, digest, strictest severity, cumulative horizon, renewal count, and target-authorized kind-specific progress projection semantically changed from the verifier-selected same-kind signed baseline for the same defect/route / all proposed deferrals and renewals | Signed policy plus canonical/deferral graph/baseline-set join; absent-to-present test/delivery/status and source-contract projections; unrelated-repo/wrong-subject/wrong-kind/reorder/replay/cross-target/stale/re-sign/no-op/regressive mutations; exactly-once recall | 100%; medium total <=7 days and 0 renewals; low total <=30 days and <=1 renewal; genuine absent-to-present unchanged-code test/delivery/status progress accepted | Any reset, over-horizon/count advisory, caller-selected or invalid predecessor baseline, hash-only/no-op/regressive or unrelated change counted as progress, wrong subject accepted, stale/replayed renewal, chain tamper, missed recall, or duplicate recall gate delta |
| Claimed-lineage material-drift re-attestation | Raw material mismatches that enter pending/unknown and remain blocking until current signed L4 proof establishes unchanged Story files plus unaffected runtime/process-policy/route/canonical dependencies / all claimed-lineage material-drift cases | Lineage verifier and shared-predicate events joined to signed re-attestation/new-assessment evidence; raw drift, valid unrelated, relevant dependency, missing/stale/tampered proof, and host-label mutations | 100% raw drift enters the floor; 100% valid complete unrelated proofs restore valid; 100% related/unknown/invalid proofs remain blocking | Any host self-classification, raw mismatch left valid, incomplete/tampered proof accepted, relevant dependency drift released, or valid complete proof refused indefinitely |
| Scorecard contract completeness | Metric rows with exact deterministic numerator/denominator/threshold/rollback result and complete HEAD/window/retry/exclusion/hardware/Story-class metadata / every versioned metric row declared in this table | Story 1 aggregator over Story 2/3 public signed queries; golden JSON plus missing/tampered/incomplete evidence mutations | 100% rows and metadata; zero protected-storage reads; refusal on any safety/prerequisite failure | Any omitted/miscomputed row, silent missing evidence, protected-storage parse, unstable JSON, or false enforce eligibility |
| Manual Finding-workflow-operation reduction | Avoided classification, triage, adjudication, reproduction, routing, and assessment operations / matched baseline workflow operations for the same Story class; genuine repair and resolve/dismiss are excluded | Process events; matched before/after or randomized warn cohort | >=50% on Finding-heavy cohort with safety floor intact | Safety breach, or no reduction after two windows |
| Review convergence | Median change in genuine review rounds and process-event elapsed time split into candidate classification, triage, adjudication, repair, and re-review convergence | Phase/process events; runs/lanes reported separately; repair is reported but never credited as a Dynamic Finding saving | >=30% reduction in classification/triage/adjudication/re-review convergence, with simple-Story regression <=10% | >10% simple-Story regression for two windows or any safety breach |
| Triage latency | p50/p95 system proposal latency from candidate-set freeze to system-signed proposal; reviewer adjudication latency is a separate series | Monotonic timing in scorecard, fixed qualification corpus/hardware | p50 <=2s and p95 <=5s for the 2,273-Finding-scale qualification corpus | p95 >10s for two windows or timeouts >1% |

Candidate conversion has no universal "higher is better" threshold: a precise
detector may promote many candidates, while a broad safety detector may promote
few. Unexplained drift is the signal. Similarly, reduced Finding count is never
accepted as a safety metric by itself.

## 12. Canonical Lab package scope-change example

This example demonstrates why applicability must be dynamic. The separate
identity-cutover Story has since completed the package rename; this document
records the scope transition without reintroducing the retired package token.

### 12.1 Historical scope

`docs/requirements/decisions/proof-or-stop-identity-migration.md`, under
"Out of scope, verified untouched", states that the sibling utils and lab
package identities were not renamed because the operator had enumerated only
the core package identity. That is an explicit historical scope
decision, not evidence that the lab package name was accidentally missed.

At the post-cutover documentation HEAD, current code/package evidence is:

- `packages/lab/package.json` names the canonical Lab package.
- `packages/main/package.json` depends on the canonical Lab package.
- relevant package lockfiles contain the canonical package key/name.
- `scripts/verify-global-lab-entrypoint.mjs` explicitly asserts
  the canonical Lab and core dependency keys.
- `packages/lab/src/index.ts`, `register.ts`, and `tool-defs.ts` use canonical
  package commentary.
- `bin/bootstrap-runner.js` loads lab `dist` by filesystem path; that proves
  local bootstrap wiring, not npm package-name resolution.

These are current grep/package observations. A grep hit alone is neither a
Finding nor gate evidence.

### 12.2 Applicability transition

1. Preserve B-cc10 and its decision unchanged.
2. Under B-cc10's old scope digest, a proposed assessment for changing the lab
   sibling name is `out_of_scope` with `decision_scope` evidence.
3. The new operator instruction explicitly adds the Lab package identity
   migration to a new rename Story's scope.
4. The scope digest changes. Any old applicability assessment becomes stale; it
   is not edited or reused.
5. A current reviewer checks manifests, exact-name consumers, lockfiles,
   publishing/install policy, and behavior. Current evidence mints the Finding
   and assessment.
6. For the new rename Story the result is
   `evidenceState=verified + verdict=applicable`, signed against the new scope
   and current material.

The historical decision explains the transition but cannot block or unblock
the new Story by itself. A source-lineage match, signature tag, old DONE outcome,
or old out-of-scope verdict remains non-authoritative until current evidence is
minted.

### 12.3 Brand scope is not package-resolution proof

Changing a manifest key to `@proof-or-stop/lab` does not prove that a clean
package manager can resolve it. A future rename Story must choose one contract:

- publish and resolve `@proof-or-stop/lab` from the configured registry; or
- use an explicit local workspace/file-link contract for repository builds.

Acceptance must cover:

- lab package manifest name;
- main dependency key/version or local link;
- main/lab/utils lockfile consistency where those lockfiles reference lab;
- exact-name assertions in `verify-global-lab-entrypoint.mjs`;
- a clean temporary install with an empty package cache context appropriate to
  the chosen contract;
- lab build and global lab command discovery;
- package import/resolution by canonical name.

A filesystem-path bootstrap pass is not a clean-install witness. Likewise, a
registry 404 would be a package-resolution failure, not proof that the brand
scope decision is wrong.

### 12.4 Boundary

The example does not rename anything, does not retroactively edit B-cc10, and
does not silently include the utils package, the root package, signature salts,
agent role IDs, archived evidence, or other frozen identities. Any such scope
expansion needs a new decision and a new assessment. In particular, the
operator's Lab request alone was not authority to rename utils.

## 13. Risk analysis and stopping rules

| Failure scenario | Trigger | Consequence | Mitigation / stop rule |
| --- | --- | --- | --- |
| A real high/critical issue is classified non-blocking | Missing/weak scope evidence, model confidence, or bad duplicate owner is accepted | False green REVIEW/TEST transition | Fail closed; zero-event safety threshold; immediate enforce -> warn kill switch |
| Assessment integrity is waived or latched into repair | A required high/critical assessment in the exact invalid set reaches round policy, a raw/caller assessment bypasses the signed integrity reader, the signed state has an invalid binding, or a later strong non-applicable proof cannot release the temporary projection | False green, or an unrelated Story is forced to perform Red-to-Green repair without applicable evidence | Registered L4 signer/verifier/reader artifact consumed only by the shared predicate; exact nine-state and binding Cartesian matrix; release/convert/remain transitions plus clean initial controls; any raw/direct-consumer bypass or latched valid control stops enforce |
| Mandatory repair decays, is assessment-erased, or status-bypassed | A confirmed applicable/protected/invalid-deferral obligation is confused with the temporary integrity projection, a replacement omits old deferral state, the repair floor runs after ordinary predicates, or classification audit append fails/races | Applicable high/critical/protected-surface or previously deferred defect clears without strong release/repair proof | Ledger/canonical claim scan first; assessment-integrity floor second; mandatory-repair classification floor third; exact-boundary/drift/write-failure/race tests; only the repair closure/release contract clears the confirmed obligation; any bypass stops enforce |
| A correct assessment survives changed runtime bytes | Receipt omits artifact/build binding | False blocker or false pass | Story 3 runtime receipt prerequisite; mutation/tamper campaign; no enforce without 100% rejection |
| Parallel reviewers lose or alias records | New record path bypasses shared transaction | Audit evidence disappears | Story 3 first; concurrency/idempotency tests; contract verifier requires atomic persistence |
| Historical similarity becomes authority | Recall/tag/playbook is read by gate | Old context silently changes lifecycle | Hard `authority=non_authoritative`, `gateEvidence=false`; process-fact verifier rejects dependency |
| Suspected routing is mistaken for verification or deferral | Candidate route is read as a promoted Finding, verified repair obligation, or gate fact | Unverified work silently blocks/unblocks a Story or disappears from review | Separate `CandidateRoute` schema; explicit uncertainty/evidence/receipt; atomic append; hard non-authoritative/no-gate contract; recall before any new assessment |
| Source Story self-signs target acceptance | Receipt signer/owner/target authority is not checked or a ledger writer is treated as semantic authority | Work is exported to a target that never accepted it | Target-authorized Story actor or canonical B-META/main-write authority only; exact source/target/lease/policy binding; rejection/revocation/freshness tests |
| Route loops or a closed target hides an obligation | Route has no exact responsibility ref/chain digest, target closes or owner changes without revocation | An issue is endlessly rerouted or silently orphaned | Target responsibility ref/hash, visited-target chain check, B-META canonical authority only, and target/owner/closure revocation plus recall mutations |
| Lifecycle commits evaluate stale gate data | A consumer preflights one blocker set and commits after assessment/route/policy/material drift | REVIEW/TEST/DONE or release passes a different state | Signed scope-specific `GateEvaluationSnapshot`; same-transaction evaluation or exact commit-time CAS; every digest race and scope mismatch aborts |
| Delivery dependency reverses or a new gate bypass appears | 3A imports 3B/Story 2/1, 3B imports Story 2/1, Story 2 imports 3B/Story 1, or a new registry/policy/allowlist consumer reads advisory data or bypasses the shared predicate | Prerequisites cycle or a new lifecycle path silently defeats non-authority/floor rules | Only `3B -> 3A`, `Story 2 -> 3A`, and `Story 1 -> {3A,3B,Story 2}` are allowed; mutation fixtures reject every other edge and direct advisory/shared-predicate bypass |
| Receipt/baseline-to-deferral TOCTOU or partial apply | Story 1 validates a receipt/baseline before the transaction, binds only IDs, or writes deferral and manifest separately while receipt or baseline bytes change | A deferral becomes authoritative against stale target consent or a different progress before-state | Persist the target-authorized receipt plus baseline set standalone/non-gate; later same-transaction CAS of latest receipt ID/hash/profile/source/freshness and exact baseline-set ID/hash/bytes; atomic deferral+manifest/action; any mismatch writes neither |
| A progress baseline is promoted directly into gate authority | Its non-gate marker is missing/flipped, it impersonates a receipt/L4 profile, or a new registry/policy/allow-list consumer reads it directly | Advisory target before-state blocks, passes, or unblocks lifecycle without an applicability disposition | Signed/hash-covered `progress_baseline` marker on entry and set; distinct non-gate registration; mutation tests for marker/profile and blocker/pass/unblock consumers; only exact-CAS-derived Story 1 L4 state may gate |
| Initial progress baseline is absent, fabricated, or caller-selected | The initial route captures no semantic before-state, a later caller supplies the predecessor digest, or only hash inequality is checked | Unrelated, no-op, or regressive target activity renews an applicable defect indefinitely | Target-authorized CLI/server capture of all four signed present/absent baselines with exact subject binding; deferral/manifest CAS the set ID/hash; verifier selects the same-kind predecessor; any invalid baseline or non-semantic transition fails closed |
| Deferral becomes an unowned waiver | Reproduction or acceptance/protected-surface analysis is incomplete, route receipt is missing/invalid, owner disappears, or target closes unfixed | An applicable defect silently falls out of current repair and future recall | Verified low/medium plus current reproduction only; exact-receipt CAS then atomic deferral+manifest/action; expiry/trigger recall; invalid claimed lineage enters the enforce mandatory floor; any false deferral stops enforce |
| Deferral becomes indefinite | Per-row clock resets, policy bytes are tampered/rebound, unrelated repository change is called progress, or stale/replayed/cross-target/no-op evidence is re-signed | Open applicable work stays advisory forever | Authentic effective V1 policy and immutable row binding; ledger-derived clock/count/horizon; medium no renewal; low one only with kind-specific target-signed projection progress for the same defect/route; exhaustion enters mandatory repair |
| Material-only drift is self-declared unrelated | A host sees matching Story files and skips dependency proof, or a stale/tampered re-attestation is accepted | A deferral survives changed runtime, process policy, route authority, or canonical dependency bytes | Any raw material mismatch first becomes blocking `pending_re_attestation`; only current signed L4 proof over every bound dependency can restore valid; related/unknown/invalid proof or host narration remains blocked |
| Scorecard falsely authorizes enforce | Aggregator omits a metric/evidence row, computes a boundary incorrectly, reads protected storage, or ignores an unmerged prerequisite/safety threshold | Enforce starts without the evidence the rollout claims | Story 1 checked-in read-only JSON aggregator over signed Story 2/3 queries; deterministic every-row fixtures and metadata; missing/tampered/incomplete evidence or any failed threshold/prerequisite is refusal |
| Canonical identity fabricates a cause | Root cause is required before investigation has established it | False lineage and bad future routing become durable history | `rootCauseState`; optional cause; trigger/repro/contract identity; append-only correction/supersession; any fabricated cause stops promotion |
| Review work does not converge after filtering/routing | Genuine defects remain or task is ill-posed | Dynamic system is blamed or used to waive work | Keep existing `stall_resolution_set` adjudication; stop promising further efficiency and replan/split when convergence backstop fires |

If Story 3 cannot prove lossless idempotent writes, Story 2 may remain a read-only
prototype and Story 1 may not persist or enforce. If Story 2 cannot establish
supersession-aware identity with measured retrieval, Story 1 may assess only
current Findings without historical auto-suggestion and may not claim P3/P5/P7
coverage. If the qualification set finds one false non-blocking high/critical
decision, one assessment-integrity invalid-set/transition/control failure, one
ledger-claim erasure or mandatory-repair-floor/audit-write-race bypass,
one unauthorized route acceptance, one exact-receipt CAS/atomicity failure, one
candidate-route/direct-advisory gate delta, shared-predicate bypass, forbidden
Story import, expiry-policy mutation/rebinding, false/reset/over-horizon/wrong-
projection progress deferral, missing/fabricated/caller-selected initial baseline,
one baseline marker/profile mutation or direct baseline gate dependency accepted,
raw material drift left valid or invalid/related re-attestation accepted,
incomplete/tampered scorecard or false enforce
eligibility, one fabricated canonical root cause, or one
protected-surface Finding accepted for deferral, enforce stops regardless of
efficiency gains.

## 14. Code and decision anchors

Line numbers drift; symbol names and CLI queries are the durable anchors.

| Concern | Current anchor |
| --- | --- |
| Finding type and audit-only fields | `packages/main/src/core/types.ts` — `Finding` |
| Shared current blocker predicate | `packages/main/src/core/advisory.ts` — `isEvidenceStateBlocking`, `isFindingBlocking` |
| Finding add/resolve/dismiss and current critical section | `packages/main/src/handlers/finding.ts` — `withMetaFindingLock`, `finding_add`, `finding_resolve`, `finding_dismiss` |
| Stable Finding reader/writer | `packages/main/src/core/store.ts` — `readFindings`, `writeFindings` |
| Current file-overlap clustering | `packages/main/src/core/cluster-compute.ts` — `clusterFindings` |
| Current structured recall | `packages/main/src/core/story-recall.ts` — `recallSimilarStories` |
| Review transition guard | `packages/main/src/core/machine.ts` — `canPassReview` |
| Guard diagnostic | `packages/main/src/core/guard-utils.ts` |
| Other blocker projections | `core/reviewer-status.ts`, `core/lifecycle-readiness.ts`, `handlers/certification-window.ts`, `handlers/reviewer-batch.ts`, `core/review-convergence.ts` |
| Current process-fact levels | `packages/main/src/core/process-fact-levels.ts` |
| Process-fact assembly/semantics | `packages/main/src/core/process-fact-registry.ts` |
| Command authority/ownership | `packages/main/src/core/command-policy.ts` |
| Contract verification | `scripts/verify-process-fact-contract.mjs` |
| Learning remains advisory | historical experience-layer execution decision (archived provenance) |
| Source lineage and non-authority | `docs/requirements/decisions/source-lineage-dedup-playbook-seed-promotion-execution-plan.md` |
| Whole-tree versus Story-file drift | `docs/requirements/decisions/story-files-hash-material-drift.md` |
| Existing convergence backstop | `docs/step3-review-budget-breaker-handoff.md`, `core/review-convergence.ts`, `handlers/stall-adjudication.ts` |
| Historical lab exclusion | `docs/requirements/decisions/proof-or-stop-identity-migration.md` |
| Current lab exact-name contract | `packages/lab/package.json`, `packages/main/package.json`, `scripts/verify-global-lab-entrypoint.mjs` |
| Filesystem-path lab bootstrap | `bin/bootstrap-runner.js` — `LAB_DIST`, `importDistModules`, `runLocalBootstrap` |

## 15. Implementation acceptance summary

The program is complete only when all of the following are true in merged state:

- The design still has exactly four components and the three distinct paths:
  suspected candidate route, verified low/medium defer-with-proof, and mandatory
  current repair.
- Signals/candidates cannot enter a lifecycle blocker set.
- Current verified Findings remain the durable truth record.
- Every Finding-system transaction is atomic, unique, idempotent, and receipted:
  Story 2 may create a standalone non-gate receipt, while Story 1's later CAS
  transaction either commits both deferral and manifest/action or neither.
- Historical lookup is lineage-backed, supersession-aware, and measured.
- Historical matches remain non-authoritative until current evidence is minted.
- Runtime execution evidence binds the bytes actually executed to source and
  command.
- Applicability is target-Story-specific, signed, fresh, and routed.
- A verified open high/critical Finding whose required assessment is a member of
  `REQUIRED_ASSESSMENT_INVALID`—exactly `missing`,
  `re_attestation_required`, `stale`, `unsigned`, `tampered`, `mismatched`,
  `incomplete`, `expired`, or `unknown`—enters a transient assessment-integrity
  floor before severity, round, or advisory policy. The final-acceptance matrix
  explicitly includes blocking `re_attestation_required` and `expired` cells.
  The projection is not a confirmed applicable repair obligation and does not
  require Red-to-Green closure. A later fresh signed strong non-applicable
  verdict releases it through its independent proof contract; a fresh applicable
  verdict converts to mandatory repair; a weak or invalid verdict remains
  blocked. Clean initial and transition controls must have identical final
  results.
- The assessment-integrity floor receives only a signature-valid, L4-registered
  `AssessmentIntegrityState` from its signer/verifier/reader, bound to the
  Finding, Story, assessment, head, material, story-files, scope, runtime, and
  process policy. Its nine invalid states, state/assessment correspondence,
  release/convert/remain transitions, missing-state behavior, and sole
  `isDynamicFindingBlocking` consumer are mutation-tested; raw/caller data and
  every unregistered direct consumer refuse enforce.
- Applicable verified critical/high and known/unknown protected-surface risks
  create a signed non-decaying mandatory-repair floor checked before status,
  severity, and round policy; only fresh Red/repro, root-cause, fix, Green, and
  closure evidence permits resolution/clearance.
- Claimed-deferral existence is derived from immutable ledger/canonical chains,
  never from a fresh assessment. Once committed, missing/stale/tampered/
  lineage-omitting replacement assessments and scope/story-files/material/
  runtime drift yield missing/stale/unknown `DeferralLineageState` in the first
  floor, as do expired/exhausted/tampered/exact-boundary states, even if the
  classification audit append fails/races; low/medium severity, status mutation,
  and round decay cannot bypass it.
- Only a fresh signed strongly proven `pre_existing_unaffected`, `out_of_scope`,
  `duplicate`, or `disproven` superseding artifact, or complete repair closure,
  releases a previously claimed lineage; a new assessment omission cannot.
- Fresh strongly proven pre-existing/out-of-scope/duplicate verdicts, and a
  target-bound strong `not_reproduced_under_current_witness` with live accepted
  owner/route plus signed current negative command/runtime witness and
  command-policy/witness digests, remain independent of the mandatory-repair
  floor and may release only the transient assessment-integrity projection when
  no other obligation exists. The current-witness verdict never releases a
  claimed-deferral lineage or an existing mandatory-repair floor; warn rollback
  restores the exact old predicate.
- Suspected low/medium observations may take the separate non-authoritative
  candidate-routing path with explicit uncertainty, evidence, a live existing
  target/owner, and a signed route receipt; this requires no promotion, root
  cause, or Green evidence and can never affect a gate.
- Every accepted route receipt binds the exact source subject and target state/
  scope to a current target-authorized owner/command-policy actor; B-META uses
  canonical audit/main-write authority. Rejection, revocation, owner/lease/policy
  drift, target closure, expiry, or tamper removes its authority.
- Story 2 independently owns those receipt semantics on Story 3 persistence and
  may commit a standalone receipt or atomically commit an initial finding-route
  receipt with its target-authorized CLI/server-derived four-kind
  `InitialProgressBaselineSet`; every entry and set carries a hash/signature-
  covered `progress_baseline`/`target_route_semantic_only`/`gateEvidence=false`
  marker and remains non-gate. Story 1
  later uses a separate same-transaction CAS of the latest exact receipt ID/hash/
  profile/source assessment proposal ID/digest/freshness state and exact
  baseline-set ID/hash/bytes,
  then atomically writes deferral plus manifest/action. A mismatch writes
  neither, receipt/baseline-alone is legal/non-gate, and deferral-alone is
  invalid. There is no Story 2 -> Story 1 dependency.
- 3A imports neither 3B nor Story 2/1; 3B imports only 3A; Story 2 imports
  only 3A; Story 1 may import 3A, 3B, and Story 2, never the reverse.
  Dependency fixtures and registry/command-policy/phase-allowlist mutations
  reject every forbidden import, direct CandidateRoute/standalone-receipt/
  individual-baseline/baseline-set/historical-advisory gate consumer, or shared-
  predicate bypass before enforce. Marker removal/flip and receipt/L4-profile
  impersonation also fail.
- Defer-with-proof is a disposition inside the four-component design, not a new
  verdict/component: only verified applicable low/medium Findings with current
  reproducible failure evidence, no acceptance or protected-surface impact, no
  current regression, and an existing receipted owner/route may use it. Root
  cause, repair, and Green evidence may remain for that target Story.
- Final applicable assessments are a discriminated two-path contract:
  `repair_current` forbids a route, whereas `defer_with_proof` requires the
  exact accepted proposal ID/digest and receipt tuple. Receipt shape does not
  relax eligibility: critical/high and known/uncertain protected-surface cases
  always remain `repair_current`; only otherwise eligible low/medium cases may
  reach deferral policy.
- V1 deferral authority is cumulative across the canonical defect/supersession
  lineage: immutable earliest `firstDeferredAt`; medium total <=7 days with no
  renewal; low total <=30 days with at most one target-authorized, materially
  progressed renewal. Severity/target/Story/canonical changes cannot reset it.
- The expiry-policy verifier rejects signature/signer/digest/version/effective-
  time/V1 constant/hard-ceiling or disposition-binding mismatch. Append-only
  policy supersession cannot rebind existing rows or reset first time/count/
  horizon.
- Missing/unchanged progress, clock/horizon/count boundary, or lineage tamper
  enters mandatory repair/current gate and emits exactly-once recall; renewal is
  new assessment/receipt/deferral rows, never an in-place edit.
- Renewal progress is a canonical typed, target-authorized signed tuple bound to
  the canonical defect/route/affected contract or target acceptance item,
  evidence ID/hash/signature/time, current authority snapshot, predecessor, and
  kind-specific projection digests. Relevant source/contract, defect-bound test
  command/selector/outcome, signed delivery item, or allowed work-state
  transition proves progress; unchanged-code test/delivery/status progress may
  pass, while unrelated repository/head/material, wrong subject/command/item,
  stale/cross-target/reordered/replayed/re-signed-no-op tuples cannot.
- Every initial deferral binds the exact signed initial baseline set in its
  disposition and manifest digests. Renewal's predecessor projection is
  verifier-derived from that set's same-kind entry, never caller-selected;
  missing/tampered/wrong-kind/wrong-subject baselines fail closed. A canonical
  absent baseline may progress to a later defect-bound test/delivery/status
  projection with unchanged code, but hash inequality, no-op, regression, or
  unrelated activity does not prove progress.
- A baseline entry or set never directly supplies blocker, pass, or unblock
  evidence. Process-fact registry, command policy, and phase allow-list register
  them separately as non-gate advisory artifacts; only Story 1's signed L4
  `FindingDeferralDisposition`/`DeferralLineageState`, created after exact
  receipt-plus-baseline CAS, may project their semantics into the shared gate.
- For a claimed deferral lineage, any raw `materialHash` mismatch first becomes
  first-floor `pending_re_attestation`, including when `storyFilesHash` matches.
  Only a current signed L4 re-attestation or equivalent new-assessment proof
  that all bound runtime receipts, process policy, route, and canonical
  dependencies are unaffected restores valid. Related/unknown dependencies,
  missing/stale/tampered proof, and host self-classification remain blocking;
  unchanged bindings may avoid full re-review but cannot avoid re-attestation.
- Story 1 owns checked-in read-only `finding_rollout_scorecard --json`; Story 2/3
  expose signed public query contracts. Deterministic fixtures cover every metric
  row's exact numerator/denominator/threshold/rollback and all required metadata;
  no protected-storage parse is allowed, and missing/tampered/incomplete evidence
  or any failed safety threshold/window/merged prerequisite refuses enforce.
- Deferred Findings retain truth, severity, and open status; in enforce,
  invalid, expired, tampered, overdue, trigger-matched, or ownerless claimed
  deferrals enter the verifier-derived mandatory floor and are also recalled
  only as non-authoritative candidates. Warn rollback restores the old
  predicate.
- Verified applicable high/critical Findings and all known or uncertain
  protected-surface risks complete Red/reproduction, root cause, fix, and Green
  evidence in the current Story; disproven Findings are released only by
  counter-evidence.
- Canonical semantic identity may precede cause discovery;
  `rootCauseState='unknown'` carries no fabricated cause, and later correction
  preserves history through supersession.
- Every non-blocking real high/critical issue has a valid owner.
- The named `REQUIRED_ASSESSMENT_INVALID` exact nine-state constant cannot
  downgrade an otherwise blocking Finding; final acceptance fixtures explicitly
  exercise `re_attestation_required` and `expired` as blocking members. Its
  temporary integrity projection is not mislabeled as repair.
- One shared predicate drives every blocker consumer and is registered as an L4
  process fact with contract-verifier coverage.
- That predicate receives only a signed `GateEvaluationSnapshot` with explicit
  `target_story`, `canonical_owner`, or `repository_release` scope; transition
  commits recheck it by CAS, target routing cannot clear canonical/release risk,
  and scope omission/mismatch or any race fails closed.
- Assessments are discriminated signed contracts over immutable `FindingRef`
  identity/version and their complete dependency bundle. Freshness is separately
  policy-bound and expiring; dependency drift, missing, or expiry never becomes
  a verdict or gate input. Current-witness non-reproduction is its own verdict.
- Accepted routes bind a live target responsibility ref/hash, owner authority,
  route-chain/cycle digest and exact receipt bytes; responsibility/owner/target
  closure or change revokes and recalls rather than silently waiving work.
- Story 3 completes 3A ledger integrity before Story 2 authority and 3B runtime
  integrity; only 3A+3B+Story 2 can enable Story 1 enforce. Fenced local-FS
  writer capability, receipts, immutable blobs and fault boundaries are tested.
- Legacy Findings remain readable without bulk rewrite.
- Observe/warn/enforce and rollback behavior passes adversarial tests.
- The metrics scorecard meets the safety floor before efficiency claims are
  made.
- The existing review assurance floor and convergence adjudication remain
  effective.

This is the boundary that makes the mechanism a safe workflow optimization
rather than an automatic Finding filter.
