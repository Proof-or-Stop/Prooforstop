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
**Story 3 -> Story 2 -> Story 1 enforcement**. Story 1 may prototype read-only
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
verified Finding may defer; Candidate and Defect Identity owns advisory routing
and later recall; Freshness and Supersession invalidates stale routes/deferrals;
and Finding Ledger Integrity durably commits each route and disposition.

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
- Do not rename `@lattice/lab`, `@lattice/utils`, or any other package here.
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
| Inputs | Proposed Finding, candidate route, assessment, mandatory-repair classification/closure, deferral, supersession, manifest, `FindingRouteReceipt`, and ledger-receipt mutations; actor/session; idempotency key; expected prior digest |
| Records | Immutable ledger entries, unique IDs, transaction/commit digest, persisted signed `FindingRouteReceipt`, `FindingLedgerReceipt`, lock/lease diagnostics |
| Authority | Authoritative only for persistence integrity: whether exact bytes were durably committed once. It does not attest that the content is true. |
| Outputs | Exactly-once append result, durable ID, previous/new ledger digest, replay result, explicit conflict/refusal |
| Non-responsibilities | Detector precision, semantic equivalence, severity, applicability, routing judgment, or freshness interpretation |

Every Finding-system mutation named above, including a non-authoritative
candidate route, must use this shared primitive. No new manifest writer may
bypass it. The primitive must compose with existing per-Story locks and
main/B-META write coordination without nested-lock deadlock.

### 5.2 Candidate and Defect Identity

| Contract | Definition |
| --- | --- |
| Inputs | Detector outputs, reviewer suspicions, current source anchors, Finding history through the stable accessor/CLI port, source-lineage records, supersession-aware historical rows |
| Records | `DetectorSignal`, `CandidateFinding`, non-authoritative `CandidateRoute`, `CanonicalDefect`, `CanonicalDefectSupersession`, derived historical index, candidate-to-Finding promotion receipt |
| Authority | Signals, candidates, auto signatures, recall hits, and the index are advisory. A designated reviewer plus CLI may confirm identity or promote a currently verified Finding, but historical identity alone has no gate authority. |
| Outputs | Deduped/grouped candidates, evidence-bearing suspected routes, canonical defect suggestions/confirmations, ranked historical candidates, affected symbols/contracts, current canonical historical row, and trigger-matched recall candidates for candidate routes and routed deferrals |
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
| Records | Signed `FindingApplicabilityAssessment`, `MandatoryRepairClassification`, `FindingRouteReceipt`, `FindingDeferralDisposition`, versioned `DeferralExpiryPolicy`, signed batch disposition manifest, reviewer override/adjudication with reason |
| Authority | Advisory in observe/warn. In enforce, only the designated CLI writer plus eligible current reviewer may mint the signed L4 assessment consumed by the shared predicate. |
| Outputs | `applicable`, `pre_existing_unaffected`, `out_of_scope`, `duplicate`, `stale_or_not_reproduced`, or `unknown`; non-decaying mandatory-repair floor for applicable high/critical or protected-surface risk; optional defer-with-proof after eligible low/medium; target-authorized route acceptance/revocation; evidence references; gate projection |
| Non-responsibilities | Changing Finding truth/severity/status, declaring semantic identity from similarity, proving bytes were stored, producing runtime receipts, or deleting the underlying issue |

Applicability is target-specific and expiring. A Finding may be applicable to
Story A, pre-existing for Story B, and duplicate of a canonical owner in Story C.
An applicable Finding is not automatically deferrable: the separate disposition
must prove the narrow policy below and must never rewrite the applicability
verdict.

### 5.4 Freshness and Supersession

| Contract | Definition |
| --- | --- |
| Inputs | Candidate-route/assessment/mandatory-repair/route-receipt/deferral signatures and bindings, `DeferralExpiryPolicy`, current `headHash`, `materialHash`, `storyFilesHash`, scope digest, runtime receipts, predecessor/successor Finding records, route-owner/lease/policy state, source hashes, clock |
| Records | `RuntimeEvidenceReceipt`, `FindingSupersession`, route-receipt revocation/freshness, mandatory-repair closure freshness, candidate-route/deferral expiry evaluation, canonical-current-record projection, re-attestation advisory |
| Authority | Runtime receipts and signed assessment freshness are authoritative only for the evidence they bind. Supersession is authoritative for historical record selection after signature/chain validation. Historical content remains non-authoritative for a new Story until revalidated. |
| Outputs | fresh, valid-with-re-attestation-advisory, stale, expired, tampered, missing; canonical current historical record; exact invalidation/reopen reason |
| Non-responsibilities | Deciding whether a detector hit is a defect, whether two sources are semantically equivalent, assigning severity, or persisting records without the ledger component |

This component is intentionally delivered across two prerequisite Stories and
the applicability consumer: Story 2 owns historical supersession/canonical
lookup; Story 3 owns runtime receipts and artifact invalidation; Story 1 binds
source/scope/runtime freshness into assessments and the gate.

### 5.5 End-to-end flow

```text
detector/reviewer observation
  -> DetectorSignal                         [advisory; never gate]
  -> CandidateFinding                       [advisory; dedup/group/reproduce]
  -> optional CandidateRoute                [suspected low/medium; advisory;
                                              existing owner + route receipt]
  -> later recall as CandidateFinding only
  -> or reviewer + CLI current verification
  -> existing Finding(evidenceState=verified)
  -> CanonicalDefect link                    [identity; historical hint only]
  -> target-Story base/head/scope/owner analysis
  -> RuntimeEvidenceReceipt where execution uses mutable artifacts
  -> FindingApplicabilityAssessment          [signed, current, L4 in enforce]
  -> MandatoryRepairClassification           [applicable high/critical or
                                                protected-surface risk; L4 floor]
  -> Red/repro -> root cause -> fix -> Green  [mandatory floor closure]
  -> or FindingRouteReceipt                  [target authority accepts/rejects]
  -> optional FindingDeferralDisposition      [applicable low/medium only;
                                                accepted route + finite expiry]
  -> batch disposition manifest              [atomic/idempotent apply]
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
  currentEvidenceRefs: string[];
  canonicalDefectCandidateId?: string;
  promotionFindingId?: string;
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
  source: {
    subjectKind: 'candidate_finding' | 'finding_assessment';
    subjectId: string;
    subjectHash: string;
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
  supersedesRouteReceiptId?: string;
  policyDigest: string;
  signedBy: string;
  signedByAuthority: RouteAcceptanceAuthority;
  receiptHash: string;
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
  memberFindingIds: string[];
  canonicalFindingId: string;
  identityState: 'suggested' | 'reviewer_confirmed' | 'superseded';
  confirmedBy?: string;
  confirmedAt?: string;
  sourceLineageKeys: string[];
  identityDigest: string;
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

interface FindingApplicabilityAssessment {
  schemaVersion: 1;
  assessmentId: string;
  storyId: string;
  findingId: string;
  verdict:
    | 'applicable'
    | 'pre_existing_unaffected'
    | 'out_of_scope'
    | 'duplicate'
    | 'stale_or_not_reproduced'
    | 'unknown';
  basis:
    | 'introduced_by_diff'
    | 'direct_scope'
    | 'base_head_reproduction'
    | 'canonical_duplicate'
    | 'decision_scope'
    | 'counter_evidence';
  owner: 'current_story' | 'meta' | 'other_story' | 'unowned';
  route?: { targetStoryId: string; targetFindingId?: string };
  evidenceRefs: string[];
  historicalSourceRefs: Array<{
    storyId: string;
    findingId: string;
    sourceFindingHash: string;
    canonicalSourceKey?: string;
  }>;
  baseHead?: {
    baseRef: string;
    baseResult: 'reproduced' | 'not_reproduced';
    headRef: string;
    headResult: 'reproduced' | 'not_reproduced';
    worsenedByStory: boolean;
    receiptIds: string[];
  };
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
  assessedAt: string;
  assessmentHash: string;
  signature: string;
}

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

interface MandatoryRepairClassification {
  schemaVersion: 1;
  mandatoryRepairId: string;
  storyId: string;
  findingId: string;
  assessmentId: string;
  state: 'required' | 'closure_proven';
  reasons: Array<
    | 'critical_or_high'
    | 'protected_surface_known_risk'
    | 'protected_surface_unknown_risk'
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
  severityCeilingSeconds: {
    medium: 604800; // 7 * 24 hours
    low: 2592000; // 30 * 24 hours
  };
  hardCeilingSeconds: 2592000;
  effectiveAt: string;
  policyDigest: string;
  signedBy: string;
  signedByAuthority: 'command_policy_authority';
  signature: string;
}

interface FindingDeferralDisposition {
  schemaVersion: 1;
  deferralId: string;
  storyId: string;
  findingId: string;
  assessmentId: string;
  canonicalDefectId: string;
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
  };
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
  createdBy: string;
  createdAt: string;
  deferralHash: string;
  signature: string;
}

interface FindingSupersession {
  schemaVersion: 1;
  supersessionId: string;
  predecessorFindingId: string;
  successorFindingId: string;
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
  artifacts: Array<{ path: string; digest: string; sourceHead: string }>;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdoutDigest: string;
  stderrDigest: string;
  environmentDigest: string;
  producer: string;
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
    findingId: string;
    assessmentId: string;
    expectedFindingHash: string;
    expectedAssessmentHash: string;
    action:
      | 'retain_blocker'
      | 'mandatory_repair'
      | 'route'
      | 'canonical_duplicate'
      | 'defer_with_proof'
      | 'retain_unknown';
    deferralId?: string;
    mandatoryRepairId?: string;
    routeReceiptId?: string;
  }>;
  scopeDigest: string;
  storyFilesHash: string;
  manifestDigest: string;
  createdBy: string;
  signature: string;
}

interface FindingLedgerReceipt {
  schemaVersion: 1;
  receiptId: string;
  storyId: string;
  idempotencyKey: string;
  operation:
    | 'append_finding'
    | 'append_candidate_route'
    | 'append_assessment'
    | 'append_mandatory_repair'
    | 'append_deferral_expiry_policy'
    | 'append_deferral'
    | 'append_route_receipt'
    | 'append_canonical_defect_supersession'
    | 'append_supersession'
    | 'apply_manifest';
  recordIds: string[];
  priorLedgerDigest: string;
  committedLedgerDigest: string;
  replayed: boolean;
  committedAt: string;
  writerSessionId: string;
  receiptHash: string;
}
```

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
  assessmentState,
  mandatoryRepairState,
  deferralState,
  policy,
  round
) =
  if mandatoryRepairFloorBlocks(
    finding,
    assessmentState,
    mandatoryRepairState
  ) then true
  else finding.status === 'open'
    && policy.effectiveBlockingSeverities.includes(finding.severity)
    && isEvidenceStateBlocking(finding.evidenceState)
    && !isAdvisoryThisRound(finding.severity, round)
    && applicabilityAndDispositionBlocks(
      finding,
      assessmentState,
      deferralState
    )
```

The mandatory-repair check is deliberately first. For a verified Finding with a
fresh `applicable` assessment, `critical`/`high` severity, any known or unknown
protected-surface risk, or a missing protected-surface evaluation creates a
non-decaying floor. The floor remains blocking even when severity would fall out
of `effectiveBlockingSeverities`, `isAdvisoryThisRound` would return true, or an
invalid direct write marked the Finding resolved. A missing, stale, unsigned,
tampered, or incomplete required classification/closure also blocks.

The only clearing state is a fresh signed superseding
`MandatoryRepairClassification(state='closure_proven')` containing Red/current
reproduction, root-cause, fix, Green, and closure evidence bound to current
source/runtime material. Resolution/dismissal handlers must refuse an active
floor; they may clear/resolve only after that closure validator passes. A fresh
strong non-applicable verdict (`pre_existing_unaffected`, `out_of_scope`, or
`duplicate`) does not create this floor and continues through its independent
proof contract. In warn/rollback mode the new classification is advisory and
the exact previous predicate is restored.

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
fresh signed unknown assessment                            -> true if the
                                                               Finding would
                                                               otherwise block
missing, unsigned, tampered, mismatched, stale, expired, or
incomplete assessment/deferral                              -> previous predicate
                                                               remains authoritative
fresh non-blocking verdict with all required proof          -> false
```

Thus applicability can remove a blocker only with stronger structured proof.
It cannot create a shortcut around the current evidence/severity/round policy.
In particular, an unknown high or critical Finding never becomes non-blocking
merely because classification failed. Outside the mandatory floor, current
round-decay semantics continue to apply; unknown does not create an extra
downgrade.

Legacy Findings with no assessment remain readable. In enforce mode, a missing
assessment projects to `unknown`; any Finding blocked by the previous predicate
continues to block. Legacy missing `evidenceState` keeps the current compatibility
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
or deferral. The candidate-route record and accepted route receipt commit
atomically; a partial write is neither an accepted route nor gate evidence.

**Path B — verified applicable low/medium deferral.** Defer-with-proof applies
only after current reproducible failure evidence establishes a
`verified + applicable` low/medium Finding. Root-cause evidence may be recorded
when already known but is not required for deferral; root-cause analysis, repair,
and fresh Green evidence belong to the receipted target Story. All of the
following are mandatory:

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
  exist as another Story or a B-META gap, and a signed `routeReceiptId` must
  prove the target/owner accepted the route. A promise to create a target later
  is insufficient.
- `recheckTriggers` and `expiresAt` are present. The route and deferral are
  committed atomically through the ledger; neither may exist alone.
- `expiryPolicyVersion` and `policyDigest` bind the disposition to the current
  signed `DeferralExpiryPolicy`. Version 1 permits at most 7 * 24 hours for
  medium and 30 * 24 hours for low, with a hard 30-day ceiling. Validation
  requires `createdAt < expiresAt <= createdAt + severity ceiling` and the route
  receipt must remain accepted and valid through `expiresAt`.

**Path C — current-Story mandatory repair.** A verified applicable
`critical`/`high` Finding cannot be deferred. Neither can any Finding with known
or uncertain data-integrity, security/privacy, package publish/clean-install,
primary CLI entrypoint, Agent-resolution, historical-evidence-integrity, or
lifecycle-gate impact, regardless of assigned severity. The current Story must
record Red/reproduction evidence, establish root cause, fix the defect, and
record fresh Green/closure evidence before the blocker can clear. A signed
`MandatoryRepairClassification(state='required')` represents this non-decaying
floor until a fresh superseding `closure_proven` record validates the complete
chain.

Deferral is a disposition after `applicable`, not another applicability verdict.
It does not mean `out_of_scope`, `pre_existing_unaffected`, `duplicate`,
`disproven`, resolved, or dismissed; those existing verdict/truth paths retain
their stronger independent proof contracts. The Finding truth, severity, and
status do not change. It remains open and operator-visible as advisory with its
canonical defect, reason, owner, target, expiry, and recall triggers.

Triage is complete only when every otherwise-blocking open Finding has a valid
current assessment, every applicable mandatory condition has a matching fresh
classification/manifest action, and every `defer_with_proof` action has a
matching signed deferral plus route receipt. A valid deferred low/medium Finding
does not block the current Story. A missing, invalid, expired, tampered,
ownerless, or partially applied deferral restores the previous authoritative
predicate; it is never interpreted as a waiver, pass, or terminal Finding
outcome.
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
- `acceptedAt` is required only for `decision='accepted'`; `rejectedAt` is
  required only for rejection, and the opposite timestamp must be absent.
  Source kind/ID/hash/Story, target kind/ID/state/scope, owner identity/authority,
  policy digest, and signer authority must all match.
- Wrong target, owner, signer, source hash, or policy digest; a stale/closed
  target; owner/lease/policy change; explicit revocation; expiry; tamper; or a
  partial route/receipt commit makes the receipt invalid. It cannot authorize a
  candidate route or deferral.
- Rejection or later revocation is a new signed receipt naming the predecessor
  in `supersedesRouteReceiptId`; immutable accepted bytes are never edited in
  place. `revokedAt` requires `revocationReason` and a predecessor. The latest
  fresh valid receipt in that chain is authoritative.

Story 1 owns the semantic acceptance/rejection/revocation commands, signer and
verifier, target-authority checks, and freshness reader. Story 3 only persists
the signed bytes atomically and proves exactly-once commit; its ledger receipt
cannot confer target acceptance. Story 2 consumes valid current route receipts
for recall but cannot mint them.

Deferral renewal is append-only. `expiresAt` is never edited or extended in
place. Continuing beyond the current expiry requires a fresh applicability
assessment, a new target acceptance/route receipt, and a new deferral that names
the old row in `supersedesDeferralId`; the expired predecessor remains auditable.
V1 parses strict UTC timestamps against the CLI's trusted clock and rejects an
invalid/future `createdAt`, non-monotonic timestamps, overflow, or an already
overdue proposal.
At the exact expiry boundary the old deferral is invalid, the previous blocker
predicate resumes, and candidate recall is emitted exactly once for that trigger
set.

### 7.4 Proof required for a non-blocking verdict

| Verdict | Minimum proof before it may be non-blocking |
| --- | --- |
| `pre_existing_unaffected` | Deterministic base and head reproduction receipts; same defect exists at base and head; Story does not worsen severity/impact; Story scope does not promise its repair; valid owner/route |
| `out_of_scope` | Signed scope/decision evidence naming the excluded contract; no contradictory checklist/acceptance promise; route to a valid owner; high/critical cannot be left unowned |
| `duplicate` | Reviewer-confirmed canonical defect; referenced canonical Finding exists and is signature-valid; live owning Story/Finding is named; no circular duplicate chain |
| `stale_or_not_reproduced` | Current commands/receipts showing non-reproduction, with source/runtime freshness; it is not inferred from an old DONE outcome |
| `unknown` | Never a non-blocking reason for an otherwise blocking Finding |

File disjointness, model confidence, historical similarity, a signature tag,
source-lineage equality, or an old out-of-scope result is insufficient.

### 7.5 Freshness and recall rules

- Matching `materialHash`, `storyFilesHash`, scope digest, and required runtime
  receipts: fresh.
- `materialHash` drift with matching signed `storyFilesHash`: valid only with an
  explicit re-attestation advisory, following
  `story-files-hash-material-drift.md`; never silently rewrite/rebind the stored
  hash or self-classify the drift as harmless.
- Changed `storyFilesHash`: stale; current Story-owned material changed.
- Changed scope digest: stale; an old out-of-scope/applicable decision cannot
  survive a scope change.
- Changed/missing runtime artifact digest or mismatched source-head receipt:
  stale.
- Missing current `storyFilesHash`: strict `materialHash` fallback.
- Invalid assessment or receipt signature/hash: tampered and fail closed.
- A rejected, revoked, expired, wrong-authority, owner/lease/policy-stale, or
  target-closed `FindingRouteReceipt` is invalid. A deferral cannot outlive its
  route receipt or its V1 severity ceiling.
- Creating or starting the target Story/gap, scope drift, material or
  `storyFilesHash` drift, runtime-binding drift, a changed affected contract,
  severity escalation, owner invalidation, target closure without a Green fix,
  or `expiresAt` recalls the routed candidate or canonical defect as a new
  `CandidateFinding` and requires a new current candidate adjudication. Only if
  current verification promotes it does a new assessment/deferral decision
  become possible.
- The prior route is historical candidate context only. It cannot directly
  block, unblock, or recreate a gate-consumed assessment.

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

Because verified-Finding applicability, mandatory repair, deferral,
target-authorized routing, and freshness change REVIEW/TEST/DONE blocker state,
their writers, signed artifacts, triage-completeness semantics, and shared
runtime predicate are L4 process facts.
`CandidateRoute` is explicitly outside that authority boundary; if registered,
its `non_authoritative`/`gateEvidence=false` semantics must be mechanically
preserved. Future implementation must update:

- `packages/main/src/core/process-fact-levels.ts`
- `packages/main/src/core/process-fact-registry.ts`
- `packages/main/src/core/command-policy.ts`
- the command catalog/registry and phase allow-lists
- `scripts/verify-process-fact-contract.mjs`

The registry/contract verifier must explicitly enumerate the future semantic
handlers for route accept/reject/revoke, mandatory-repair classify/close, and
deferral create/supersede; their command-policy actor authority; the signed
`FindingRouteReceipt`, `MandatoryRepairClassification`, and
`DeferralExpiryPolicy` artifacts; every shared-predicate consumer; and negative
tests proving no direct resolve/dismiss or per-consumer path bypasses the floor.
Exact command names remain subject to normal CLI design review. Atomic/idempotent
persistence, route-receipt validity, non-decay, finite expiry, and fail-closed
fallback are required registered semantics.
Prompt guidance is not sufficient. The contract verifier must reject a new gate
consumer that bypasses the shared predicate or accepts a candidate route or
advisory historical record as evidence.

## 8. Seven-problem ownership matrix

Each class has exactly one primary component and one primary future Story.
Secondary mitigation is named without creating duplicate ownership.

| ID | Historical evidence | Primary component | Primary future Story | Coverage | Falsifiable acceptance result |
| --- | --- | --- | --- | --- | --- |
| P1 | Corpus high-volume Stories; B-cdf6:F-061/F-062/F-065; review-budget handoff | Candidate and Defect Identity | Finding Identity and Historical Lineage | Mitigates classification/repetition cost; cannot eliminate real defects; Dynamic Applicability adds batch/routing and narrowly proven deferral mitigation | On a preregistered Finding-heavy replay set, canonical grouping and batch disposition reduce manual Finding operations by at least 50% with zero missed applicable high/critical defects or false deferrals; existing stall adjudication still triggers normally |
| P2 | B-cdf6:F-067 -> B-META-framework-audit:F-034 | Dynamic Applicability | Dynamic Finding Applicability | Direct | A verified pre-existing defect remains open under its canonical owner, has base/head/no-worsening proof, and does not block the unrelated target Story; scope change makes the old assessment stale |
| P3 | B-cdf6:F-070 / B-META-framework-audit:F-035 | Candidate and Defect Identity | Finding Identity and Historical Lineage | Directly prevents unverified signal from entering the Finding gate; detector accuracy itself remains detector-owned | Replaying the named noise shape creates detector signals/candidates but zero verified Findings until current reproduction; no candidate ID appears in a gate blocker set |
| P4 | B-cdf6:F-056 / B-META-framework-audit:F-032 | Freshness and Supersession | Finding Ledger and Runtime Evidence Integrity | Direct runtime half | Mutating or rebuilding a bound ignored artifact makes the runtime receipt/assessment stale; source-correct/runtime-wrong and source-wrong/runtime-green campaigns cannot produce an admissible verdict |
| P5 | B-META-framework-audit:F-030/F-031 | Freshness and Supersession | Finding Identity and Historical Lineage | Direct historical half | Canonical lookup returns F-031 as successor while retaining F-030, rejects a cycle/tampered link, and never reports the predecessor as current without a superseded warning |
| P6 | B-META-framework-audit:F-029 | Finding Ledger Integrity | Finding Ledger and Runtime Evidence Integrity | Direct | 100 concurrent unique appends persist exactly 100 unique rows; retrying every request returns the original IDs and creates zero duplicates or lost rows |
| P7 | learning/signature/source-lineage CLI audit | Candidate and Defect Identity | Finding Identity and Historical Lineage | Direct measured retrieval contract; does not promise perfect recall | A versioned gold set reports precision/recall by detector and defect family; superseded rows are excluded; every hit has lineage; historical hits remain non-authoritative and cannot alter the gate |

## 9. Three future Story contracts

### 9.1 Story 1 — Dynamic Finding Applicability

**Objective.** Add target-Story verdict, target-authorized route acceptance,
mandatory-repair floor, defer-with-proof with finite expiry, batch disposition,
signed freshness binding, and the shared gate predicate. This is the
product-facing Dynamic Finding behavior.

**Included component responsibility.** Own the Dynamic Applicability component
and the assessment-consumer portion of Freshness and Supersession. Consume, but
do not implement, Story 3 ledger/runtime primitives and Story 2 identity/
supersession lookup.

**Problems.** Directly solves P2. Mitigates P1 through batch triage and routing.
Consumes P3/P5/P7 outputs and P4/P6 guarantees; it does not claim to solve those
independently.

**Prerequisites.** For enforce: Story 3 accepted and merged; Story 2 accepted and
merged; current merged-state combination review green; review assurance floor
unchanged. Read-only observe prototypes may run earlier only if they write no
authoritative artifacts and cannot alter lifecycle output.

**Deliverables.**

- `FindingApplicabilityAssessment` schema, signer/verifier, append-only reader,
  and current projection.
- `MandatoryRepairClassification` classify/close signer, verifier, reader, and
  non-decaying floor; resolve/dismiss handler integration requires fresh
  Red/repro, root-cause, fix, Green, and closure evidence.
- `FindingRouteReceipt` semantic acceptance/rejection/revocation commands,
  target-authority and command-policy validation, owner/lease/policy freshness,
  and exact source/target binding. Story 3 supplies storage only.
- `FindingDeferralDisposition` signer/verifier and eligibility policy, including
  acceptance-impact, current-Story regression, protected-surface, target-owner,
  route-receipt, expiry, and recheck-trigger validation.
- Signed/versioned `DeferralExpiryPolicy`, V1 7-day medium and 30-day low
  ceilings, hard 30-day ceiling, immutable expiry, and superseding renewal.
- Read-only consumption of Story 2 `CandidateRoute` records with a hard
  non-authoritative/no-gate boundary.
- Exact verdict/basis/owner/route enums and proof validators.
- Base/head reproduction adapter and no-worsening decision.
- Scope, head, material, story-files, review-run, and runtime-receipt bindings.
- `finding_triage`/assessment inspection and digest-bound batch-manifest apply
  UX (final command names chosen through normal CLI design review).
- One `isDynamicFindingBlocking` predicate used by every current consumer.
- L4 command policies, process-fact entries, registry artifacts, and contract
  verifier coverage.
- Feature state `observe|warn|enforce` and kill switch.

**Required tests.**

- Applicable verified blocker remains blocking.
- Applicable verified critical/high and applicable known/unknown/missing
  protected-surface evaluation create a mandatory floor before severity/round
  decay; changing `effectiveBlockingSeverities` or `isAdvisoryThisRound` cannot
  clear it.
- Missing/stale/tampered classification and a direct resolved/dismissed write
  without a fresh closure remain blocking; closure requires non-empty current
  Red/repro, root-cause, fix, Green, and closure evidence.
- Fresh strongly proven `pre_existing_unaffected`, `out_of_scope`, or
  `duplicate` remains outside the mandatory floor; warn rollback reproduces the
  exact old predicate.
- Suspected low/medium observations may be routed as candidates with uncertainty,
  evidence, a live existing target/owner, and a signed route receipt; the route
  needs no promotion, root cause, or Green evidence and never changes a gate.
- Missing candidate uncertainty/evidence/route rejects the route, while
  disproven observations are released by counter-evidence rather than deferral.
- Existing-Story acceptance succeeds only for its target-authorized
  owner/command-policy actor; B-META acceptance succeeds only for canonical
  audit/main-write authority. A source-Story author cannot self-sign either.
- Wrong source kind/ID/hash/Story, target, target scope/state, owner, signer,
  lease/policy, rejection/revocation, expiry, tamper, or target closure
  invalidates the route; partial route/receipt commit is never accepted.
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
- Missing, unsigned, tampered, scope-stale, story-files-stale, or runtime-stale
  assessment fails closed for an otherwise blocking Finding.
- Unknown high/critical is never downgraded by applicability.
- `materialHash`-only drift with matching signed `storyFilesHash` emits the
  required re-attestation advisory and does not silently rebind.
- Repeated manifest apply is idempotent.
- Invalid, expired, tampered, partially applied, or trigger-matched deferral
  restores the previous predicate and cannot act as a waiver; manifest triage
  fails when a deferred row lacks its signed route receipt.
- V1 accepts `createdAt < expiresAt` only within 7 days for medium and 30 days
  for low; exact-boundary expiry, clock skew/overdue input, and a route receipt
  expiring earlier all fail closed and emit exactly-once recall.
- Renewal cannot edit an old expiry: it requires a new assessment, new target
  acceptance, and a superseding deferral; retries remain idempotent.
- Rollback to warn restores the exact previous authoritative predicate.
- Existing review assurance floor, escalation, certification, readiness, and
  convergence surfaces report the same blocker set.

**Non-goals.** No detector/index implementation; no canonical defect inference;
no ledger primitive; no runtime receipt implementation; no historical bulk
assessment; no lab rename; no new convergence breaker; no unowned deferral; no
claim that deferred, routed, or duplicate real issues cease to exist.

### 9.2 Story 2 — Finding Identity and Historical Lineage

**Objective.** Separate raw signal from verified Finding, establish reviewable
semantic identity, resolve historical supersession, and provide measured,
lineage-backed recall.

**Included component responsibility.** Own Candidate and Defect Identity and
the historical supersession/canonical-lookup half of Freshness and
Supersession. Use Story 3's atomic ledger for authoritative identity/
supersession writes.

**Problems.** Directly addresses P3, P5, and P7. Mitigates P1 by grouping sibling
manifestations and avoiding repeated triage.

**Prerequisites.** Story 3 ledger APIs, unique IDs, idempotent append, and
transaction receipts accepted in merged state before any authoritative
identity/supersession writes. A read-only benchmark prototype may precede Story
3 but remains disposable/non-authoritative.

**Deliverables.**

- `DetectorSignal`, `CandidateFinding`, non-authoritative `CandidateRoute`,
  `CanonicalDefect`, and promotion contracts.
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
- Candidate inspection, merge, disprove, and reviewer-confirmed promotion UX.

**Required tests.**

- DetectorSignal/CandidateFinding can never appear in lifecycle blocker input.
- CandidateRoute is rejected when uncertainty, evidence, existing owner/target,
  or route receipt is missing; a valid route remains non-authoritative and
  produces no lifecycle transition delta.
- Recall consumes only a fresh accepted Story 1 route receipt; rejected,
  revoked, expired, wrong-owner/signer/target, or tampered receipts remain
  historical context and cannot generate an authoritative assessment.
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

**Non-goals.** No applicability gate; no route-receipt signer or acceptance
command; no runtime artifact receipts; no direct Finding resolution; no claim
of perfect recall; no embeddings/remote index without separate evidence and
scope; no bulk rewrite of legacy Findings.

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

**Deliverables.**

- Shared atomic append/transaction primitive for Finding, candidate route,
  assessment, mandatory-repair, expiry-policy, deferral, supersession, route,
  manifest, and receipt records.
- Unique ID allocator independent of mutable array length.
- Idempotency key, expected-prior digest/CAS behavior, durable commit receipt,
  replay result, and explicit conflict.
- Crash/interruption recovery and stale-lock diagnostics.
- `RuntimeEvidenceReceipt` signer/verifier and build/execution adapter.
- Artifact-digest/source-head/environment/command/output binding.
- Build-in-progress refusal and post-run artifact-stability check.
- Process-fact registration for atomic persistence and gate-eligible runtime
  evidence.

**Required tests.**

- 100 concurrent unique Finding appends -> exactly 100 unique durable rows.
- Concurrent mixed Finding/candidate-route/assessment/mandatory-repair/
  expiry-policy/deferral/route/manifest writes lose nothing and preserve
  referential integrity.
- Mandatory-repair classify/close and expiry-policy records are append-only,
  unique, idempotent, and never half-visible with their manifest references.
- A suspected candidate route and its prevalidated signed target receipt commit
  atomically; crash, conflict, or rejection leaves no half-route visible.
- A deferral and its prevalidated signed target route commit atomically; crash,
  conflict, or rejection leaves neither half visible, and retry returns the same
  deferral, route, and receipt IDs.
- Replaying all 100 idempotency keys -> same IDs, zero new rows.
- Two writers with a stale expected digest receive an explicit conflict; neither
  silently overwrites the other.
- Kill process between prepare/commit steps -> deterministic recovery with no
  half-visible row.
- Build/output mutation before, during, and after execution invalidates or
  refuses the receipt as specified.
- Receipt tamper, wrong source HEAD, changed command, changed artifact bytes,
  and changed environment are rejected.
- No nested-lock deadlock with current Finding and B-META write paths.

**Non-goals.** No detector classification, canonical defect judgment,
applicability verdict, target-authority/routing decision, route semantic signer
or verifier, expiry-policy judgment, historical recall, lifecycle gate
enforcement, lab rename, or claim that persistence proves semantic acceptance.

### 9.4 Dependency DAG and reconciliation

```text
Story 3: Finding Ledger and Runtime Evidence Integrity
   |\
   | \-> runtime receipts --------------------\
   v                                         |
Story 2: Finding Identity and Historical Lineage
   |    historical supersession/canonical ID |
   v                                         v
Story 1: Dynamic Finding Applicability ------> enforce gate
```

Safe sequence:

1. Implement and accept Story 3.
2. Implement and accept Story 2 on the ledger foundation.
3. Implement Story 1; keep it observe/warn until merged-state review proves
   Story 3 + Story 2 + Story 1 together; then consider enforce.

Component-to-Story reconciliation:

| Component | Delivery owner |
| --- | --- |
| Finding Ledger Integrity | Story 3 |
| Candidate and Defect Identity | Story 2 |
| Dynamic Applicability | Story 1 |
| Freshness and Supersession | Story 2: historical supersession/recall; Story 3: runtime receipts and atomic bytes; Story 1: assessment, mandatory-repair, route-receipt, and deferral-expiry freshness |

No component or failure class is orphaned. No failure class has two primary
owners. The complete program covers P1-P7 at the structural level described in
the matrix; Dynamic Applicability alone does not.

Parallel implementation does not relax ordering: branches may prototype
non-gating work concurrently, but any process-framework deliveries must receive
a merged-state combination review before Story 1 enforce. No Story may lower
the existing review assurance floor to make the combination pass.

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
| `observe` | Read-only classifier/index prototype passes structural tests | None; stdout/report only. Benchmark artifacts, if explicitly exported outside lifecycle state, remain non-authoritative. | Existing `isFindingBlocking` only | Candidate groups/routes, predicted mandatory floors, proposed verdicts/deferrals, target-authority/receipt gaps, expiry-policy violations, high/critical closure gaps, predicted blocker delta, latency | Exit to warn after labeled replay shows no safety violation and Story 3/2 dependencies needed by persisted advice are ready; kill switch simply disables output |
| `warn` | Story 3 atomic persistence accepted; Story 2 candidate/identity/supersession accepted; observe qualification thresholds met | Append non-authoritative candidate-route/triage/mandatory-repair/route-receipt/deferral proposals and reviewer overrides with audit lineage; no new L4 artifact may affect lifecycle | Existing predicate only; advice cannot change transition result | Old blocker set plus proposed floor, route-authority and expiry outcomes, protected-surface/closure gaps, stale/unknown/overdue warnings, override audit | Return to observe on data/persistence defect; advance only after merged-state enforce qualification |
| `enforce` | All three Stories accepted; signed current-material assessment; runtime receipt; mandatory-floor/process-fact contract; target-authorized route receipt; V1 expiry policy; legacy compatibility; adversarial and rollback tests green | Atomic/idempotent candidate route, L4 assessment, mandatory-repair, route receipt, expiry policy, deferral, and manifest records plus audit records | Mandatory floor first, then shared `isDynamicFindingBlocking`; candidate routes remain non-authoritative | Effective mandatory/blocker sets, closure chain, route signer/owner/target state, deferral policy/expiry/triggers, candidate recall, freshness, advisory drift, kill switch | Any safety threshold breach immediately changes feature state to warn and restores previous predicate; records remain append-only |

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
- Scope, Story-owned material, and runtime artifact changes invalidate exactly
  the dependent assessments and deferrals.
- An invalid, expired, ownerless, partially applied, or trigger-matched deferral
  restores the previous predicate and is never converted into a waiver.
- Wrong-authority/revoked route receipts and V1 boundary/over-ceiling deferrals
  fail closed; renewal creates new assessment/acceptance/deferral rows and never
  mutates the predecessor.
- Whole-tree-only drift is surfaced for re-attestation and is never silently
  classified by the host.
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

The future implementation must expose a checked-in read-only scorecard
procedure (planned CLI surface: `finding_rollout_scorecard --json`) backed by
ledger/process-event queries, not protected-storage parsing. Before that command
exists, the CLI-only corpus procedure in section 3 is the reproducible baseline.

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
| Unknown high/critical fail-closed | Otherwise-blocking high/critical unknown cases that remain blocking / all such unknown cases | Shared predicate fixture and live warn comparison | 100% | Any downgrade caused by unknown |
| Mandatory-repair floor and closure integrity | Applicable high/critical or known/unknown protected-surface cases that remain blocking through severity/round decay and clear only with a fresh complete closure / all injected mandatory cases | Shared-predicate, resolve/dismiss-handler, stale/tamper, and closure mutation suite | 100%; zero direct-status bypasses | Any decayed/bypassed floor or any incomplete/stale closure accepted |
| Non-blocking classification precision | Independently confirmed correct non-blocking verdicts / all reviewed non-blocking verdicts | Stratified reviewer gold set; disclose severity and verdict mix | >=98% overall and 100% high/critical safety | <98% overall or any high/critical safety miss |
| Candidate-to-verified conversion | Candidates promoted to verified Findings / all terminally adjudicated candidates, per detector/version | Candidate ledger and promotion receipts | Descriptive, not maximized; each detector preregisters a baseline band before warn | Absolute drift >10 percentage points without an explained corpus/version change pauses promotion |
| Canonical root-cause honesty | Canonical identities whose `rootCauseState` and optional value match reviewed evidence / all independently reviewed canonical identities | Identity gold set plus supersession audit | 100%; unknown cause remains representable | Any fabricated cause, cause present with `unknown`, or in-place cause rewrite |
| Duplicate/routed disposition accuracy | Correct canonical duplicate or valid routed-owner decisions / all independently reviewed duplicate/routed decisions | Manifest, canonical lookup, route target validation | >=98%; 100% of real high/critical non-blocking issues have a valid owner | Any unowned high/critical or <98% |
| Suspected-candidate route completeness and isolation | Low/medium candidate routes with explicit uncertainty, current evidence, live existing target/owner, signed receipt, expiry/triggers, and zero gate delta / all proposed suspected routes | Candidate/route ledger join, target validation, and frozen-gate before/after comparison | 100% complete and 100% zero gate delta; no promotion/root-cause/Green prerequisite | Any incomplete route accepted, any candidate promoted implicitly, or any gate delta |
| Route-receipt authority and freshness | Receipts accepted by the exact target-authorized owner/policy actor with matching source/target/hash/scope and live lease/policy / all acceptance proposals and adversarial receipts | Story/B-META authority lookup, command-policy decision log, signature/freshness verifier, and revocation suite | 100% valid; source Story self-sign acceptance is always rejected | Any wrong signer/owner/target/hash, stale/closed target, revocation, tamper, or partial commit accepted |
| Deferral route completeness | Deferred rows with a live existing target, owner, accepted signed route receipt, expiry, and complete recheck triggers / all proposed deferred rows | Atomic manifest/route ledger join plus target existence/owner validation | 100% | Any orphan, missing receipt, partial commit, or closed-unfixed target accepted as valid |
| False deferral | Independently adjudicated deferred rows that require current repair or touch a protected surface / all system-proposed deferrals | Current reproducible failure evidence, acceptance/verificationIntent diff, introduced/worsened analysis, protected-surface campaign, and independent disposition review | **0**; critical/high proposals are mechanically ineligible; root cause may remain for the target Story | Any one event or any protected-surface risk deferred |
| Stale/overdue/reopened deferral handling | Triggered, expired, owner-invalid, or target-closed-unfixed deferrals recalled as candidates and made non-authoritative / all such deferrals injected or observed | Freshness/expiry evaluator events joined to candidate recall and gate decisions | 100%, exactly-once candidate recall per trigger set | Any stale/overdue row remains non-blocking, any missed recall, or duplicate recall changes gate state |
| Deferral expiry-policy compliance | V1 deferrals satisfying `createdAt < expiresAt` and the medium/low/hard ceilings, with immutable superseding renewal / all proposed deferrals and renewals | Signed policy join, deterministic clock-boundary suite, ledger supersession, and exactly-once recall events | 100%; medium <=7 days, low <=30 days, hard ceiling 30 days | Any over-ceiling/expired row accepted, in-place renewal, missed boundary recall, or duplicate recall changes gate state |
| Manual Finding-operation reduction | Avoided individual resolve/dismiss commands on batch-eligible rows / baseline individual operations for matched Story class | Process events; matched before/after or randomized warn cohort | >=50% on Finding-heavy cohort with safety floor intact | Safety breach, or no reduction after two windows |
| Review convergence | Median change in genuine review-round count and REVIEW elapsed time for matched Story classes | Phase/process events; runs/lanes reported separately | >=30% reduction in either round count or elapsed review time, with simple-Story regression <=10% | >10% simple-Story regression for two windows or any safety breach |
| Triage latency | p50/p95 wall time from candidate-set freeze to signed proposed manifest; retries separately reported | Monotonic timing in scorecard, fixed qualification corpus/hardware | p50 <=2s and p95 <=5s for the 2,273-Finding-scale qualification corpus | p95 >10s for two windows or timeouts >1% |

Candidate conversion has no universal "higher is better" threshold: a precise
detector may promote many candidates, while a broad safety detector may promote
few. Unexplained drift is the signal. Similarly, reduced Finding count is never
accepted as a safety metric by itself.

## 12. `@lattice/lab` -> `@proof-or-stop/lab` scope-change example

This example demonstrates why applicability must be dynamic. It does not
perform the rename.

### 12.1 Historical scope

`docs/requirements/decisions/proof-or-stop-identity-migration.md`, under
"Out of scope, verified untouched", states that sibling package names
`@lattice/utils` and `@lattice/lab` were not renamed because the operator had
enumerated `@lattice/core` specifically. That is an explicit historical scope
decision, not evidence that the lab package name was accidentally missed.

At the point-in-time documentation HEAD, current code/package evidence is:

- `packages/lab/package.json` names the package `@lattice/lab`.
- `packages/main/package.json` depends on `@lattice/lab`.
- relevant package lockfiles contain the old package key/name.
- `scripts/verify-global-lab-entrypoint.mjs` explicitly asserts
  `@lattice/lab` and the core dependency key.
- `packages/lab/src/index.ts`, `register.ts`, and `tool-defs.ts` retain old-name
  comments.
- `bin/bootstrap-runner.js` loads lab `dist` by filesystem path; that proves
  local bootstrap wiring, not npm package-name resolution.

These are current grep/package observations. A grep hit alone is neither a
Finding nor gate evidence.

### 12.2 Applicability transition

1. Preserve B-cc10 and its decision unchanged.
2. Under B-cc10's old scope digest, a proposed assessment for changing the lab
   sibling name is `out_of_scope` with `decision_scope` evidence.
3. The new operator instruction explicitly adds
   `@lattice/lab -> @proof-or-stop/lab` to a new rename Story's scope.
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
does not silently include `@lattice/utils`, the root package, signature salts,
agent role IDs, archived evidence, or other frozen identities. Any such
expansion needs a new scope decision and a new assessment. In particular, the
operator's lab request is not authority to rename utils.

## 13. Risk analysis and stopping rules

| Failure scenario | Trigger | Consequence | Mitigation / stop rule |
| --- | --- | --- | --- |
| A real high/critical issue is classified non-blocking | Missing/weak scope evidence, model confidence, or bad duplicate owner is accepted | False green REVIEW/TEST transition | Fail closed; zero-event safety threshold; immediate enforce -> warn kill switch |
| Mandatory repair decays or is status-bypassed | Floor check runs after severity/round/status predicates, or resolve/dismiss ignores closure | Applicable high/critical/protected-surface defect clears without repair proof | First predicate check; signed L4 classification; resolve/dismiss refusal; complete fresh Red/root-cause/fix/Green closure; any bypass stops enforce |
| A correct assessment survives changed runtime bytes | Receipt omits artifact/build binding | False blocker or false pass | Story 3 runtime receipt prerequisite; mutation/tamper campaign; no enforce without 100% rejection |
| Parallel reviewers lose or alias records | New record path bypasses shared transaction | Audit evidence disappears | Story 3 first; concurrency/idempotency tests; contract verifier requires atomic persistence |
| Historical similarity becomes authority | Recall/tag/playbook is read by gate | Old context silently changes lifecycle | Hard `authority=non_authoritative`, `gateEvidence=false`; process-fact verifier rejects dependency |
| Suspected routing is mistaken for verification or deferral | Candidate route is read as a promoted Finding, verified repair obligation, or gate fact | Unverified work silently blocks/unblocks a Story or disappears from review | Separate `CandidateRoute` schema; explicit uncertainty/evidence/receipt; atomic append; hard non-authoritative/no-gate contract; recall before any new assessment |
| Source Story self-signs target acceptance | Receipt signer/owner/target authority is not checked or a ledger writer is treated as semantic authority | Work is exported to a target that never accepted it | Target-authorized Story actor or canonical B-META/main-write authority only; exact source/target/lease/policy binding; rejection/revocation/freshness tests |
| Deferral becomes an unowned waiver | Reproduction or acceptance/protected-surface analysis is incomplete, route receipt is missing, owner disappears, or target closes unfixed | An applicable defect silently falls out of current repair and future recall | Verified low/medium plus current reproduction only; atomic route+deferral; expiry/trigger recall; invalid state restores old predicate; any false deferral stops enforce |
| Deferral becomes indefinite | Missing ceiling, clock-boundary bug, or in-place `expiresAt` edit renews authority | Open applicable work stays advisory forever | Signed V1 7-day medium/30-day low policy; hard 30-day ceiling; immutable superseding renewal; exact-boundary and exactly-once recall tests |
| Canonical identity fabricates a cause | Root cause is required before investigation has established it | False lineage and bad future routing become durable history | `rootCauseState`; optional cause; trigger/repro/contract identity; append-only correction/supersession; any fabricated cause stops promotion |
| Review work does not converge after filtering/routing | Genuine defects remain or task is ill-posed | Dynamic system is blamed or used to waive work | Keep existing `stall_resolution_set` adjudication; stop promising further efficiency and replan/split when convergence backstop fires |

If Story 3 cannot prove lossless idempotent writes, Story 2 may remain a read-only
prototype and Story 1 may not persist or enforce. If Story 2 cannot establish
supersession-aware identity with measured retrieval, Story 1 may assess only
current Findings without historical auto-suggestion and may not claim P3/P5/P7
coverage. If the qualification set finds one false non-blocking high/critical
decision, one mandatory-floor bypass, one unauthorized route acceptance, one
candidate-route gate delta, one false/over-ceiling deferral, one fabricated
canonical root cause, or one protected-surface Finding accepted for deferral,
enforce stops regardless of efficiency gains.

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
| Learning remains advisory | `docs/requirements/decisions/lattice-experience-layer-execution-plan.md` |
| Source lineage and non-authority | `docs/requirements/decisions/source-lineage-dedup-playbook-seed-promotion-execution-plan.md` |
| Whole-tree versus Story-file drift | `docs/requirements/decisions/story-files-hash-material-drift.md` |
| Existing convergence backstop | `docs/step3-review-budget-breaker-handoff.md`, `core/review-convergence.ts`, `handlers/stall-adjudication.ts` |
| Historical lab exclusion | `docs/requirements/decisions/proof-or-stop-identity-migration.md` |
| Current lab exact-name contract | `packages/lab/package.json`, `packages/main/package.json`, `scripts/verify-global-lab-entrypoint.mjs` |
| Filesystem-path lab bootstrap | `bin/bootstrap-runner.js` — `LAB_DIST`, `importDistModules`, `runLocalBootstrap` |

## 15. Implementation acceptance summary

The program is complete only when all of the following are true in merged state:

- Signals/candidates cannot enter a lifecycle blocker set.
- Current verified Findings remain the durable truth record.
- All Finding-system mutations are atomic, unique, idempotent, and receipted.
- Historical lookup is lineage-backed, supersession-aware, and measured.
- Historical matches remain non-authoritative until current evidence is minted.
- Runtime execution evidence binds the bytes actually executed to source and
  command.
- Applicability is target-Story-specific, signed, fresh, and routed.
- Applicable verified critical/high and known/unknown protected-surface risks
  create a signed non-decaying mandatory-repair floor checked before status,
  severity, and round policy; only fresh Red/repro, root-cause, fix, Green, and
  closure evidence permits resolution/clearance.
- Fresh strongly proven pre-existing/out-of-scope/duplicate verdicts remain
  independent of the mandatory floor, and warn rollback restores the exact old
  predicate.
- Suspected low/medium observations may take the separate non-authoritative
  candidate-routing path with explicit uncertainty, evidence, a live existing
  target/owner, and a signed route receipt; this requires no promotion, root
  cause, or Green evidence and can never affect a gate.
- Every accepted route receipt binds the exact source subject and target state/
  scope to a current target-authorized owner/command-policy actor; B-META uses
  canonical audit/main-write authority. Rejection, revocation, owner/lease/policy
  drift, target closure, expiry, or tamper removes its authority.
- Defer-with-proof is a disposition inside the four-component design, not a new
  verdict/component: only verified applicable low/medium Findings with current
  reproducible failure evidence, no acceptance or protected-surface impact, no
  current regression, and an existing receipted owner/route may use it. Root
  cause, repair, and Green evidence may remain for that target Story.
- V1 deferral expiry is finite (medium <=7 days, low <=30 days, hard ceiling 30
  days); renewal is a new assessment, target acceptance, and superseding
  deferral, never an in-place edit, and boundary recall is exactly once.
- Deferred Findings retain truth, severity, and open status; invalid, expired,
  tampered, overdue, trigger-matched, or ownerless deferrals restore the old
  predicate and are recalled only as non-authoritative candidates.
- Verified applicable high/critical Findings and all known or uncertain
  protected-surface risks complete Red/reproduction, root cause, fix, and Green
  evidence in the current Story; disproven Findings are released only by
  counter-evidence.
- Canonical semantic identity may precede cause discovery;
  `rootCauseState='unknown'` carries no fabricated cause, and later correction
  preserves history through supersession.
- Every non-blocking real high/critical issue has a valid owner.
- Missing/stale/tampered/unknown cannot downgrade an otherwise blocking Finding.
- One shared predicate drives every blocker consumer and is registered as an L4
  process fact with contract-verifier coverage.
- Legacy Findings remain readable without bulk rewrite.
- Observe/warn/enforce and rollback behavior passes adversarial tests.
- The metrics scorecard meets the safety floor before efficiency claims are
  made.
- The existing review assurance floor and convergence adjudication remain
  effective.

This is the boundary that makes the mechanism a safe workflow optimization
rather than an automatic Finding filter.
