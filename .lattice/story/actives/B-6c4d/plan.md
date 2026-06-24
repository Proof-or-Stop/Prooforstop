# Plan: B-6c4d — Relax the id-recency review-run binding (kind-aware) + EMPTY storyFilesHash guard

> Verified-spike re-application. Proven red→green before this story; reference diff
> at `/tmp/friction2-runbind-fix/core-fix.diff`, red/green spike notes at
> `/tmp/friction2-runbind-fix/redgreen-spike-test.ts`. The spike additionally caught
> that a BLANKET relax breaks flow-stability's open-finding supersession, hence the
> kind-aware validate-side relax.

## CHK-001: Relax the id-recency rejection at both review-run binding sites (kind-aware on validate)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/review-run.ts

**Verify**:
- `npm --prefix packages/main run build` clean
- The regression smoke (CHK-003) shows a non-latest material-fresh PASS accepted

**DoneWhen**:
- assertCurrentReviewRunForEvidence (~669-672): the id-recency throw is removed (write-time, both kinds); a non-latest run proceeds to the freshness + scope checks
- validateEvidenceRunBinding (~794-804): the id-recency `stale_run` is emitted ONLY for `evidence.kind !== 'pass'` (kept for findings); a material-fresh non-latest PASS no longer gets stale_run

## CHK-002: Add the EMPTY_STORY_FILES_HASH no-signal guard to checkEvidenceFreshnessForGit

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/evidence-freshness.ts

**Verify**:
- The regression smoke shows a material-drifted run with an empty-set storyFilesHash hard-rejects (never advisory)

**DoneWhen**:
- The drift-advisory branch (~315) fires only when BOTH the stored and live storyFilesHash are non-empty (`!== EMPTY_STORY_FILES_HASH`); an empty-set value on either side falls through to the strict materialHash hard-reject
- Mirrors delivery-check-hash.ts:184-188; closes the hole for ALL checkEvidenceFreshnessForGit callers

## CHK-003: Add a regression smoke for the binding race and confirm flow-stability semantics hold

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (or a sibling smoke)

**Verify**:
- `node packages/main/dist/tasks/flow-stability-smoke.js` prints PASS (exit 0)
- `npm test` (root) green — no other smoke regresses

**DoneWhen**:
- A case mints two review_run_start on one lane (same round + material), binds a pass to the FIRST, and asserts it is ACCEPTED (assertCurrentReviewRunForEvidence returns; collectReviewerEvidenceState invalid empty)
- A genuinely material-drifted run AND an empty-set-storyFilesHash run still hard-reject
- The existing flow-stability assertions stay green: superseded pass not stale_run, OPEN finding bound to a non-latest run still stale_run/blocks, resolved finding superseded

## CHK-004: Write the decision doc and reconcile the lease-contract doc

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Create: docs/requirements/decisions/review-run-binding-race.md
- Modify: docs/requirements/decisions/session-ownership-and-write-leases.md

**Verify**:
- `npm --prefix packages/main run build` clean (docs change is non-code)

**DoneWhen**:
- review-run-binding-race.md records the decision (relax id-recency kind-aware, why id-recency is redundant, the EMPTY guard prerequisite, rejected alternatives incl. blanket-relax and lock-unification)
- session-ownership-and-write-leases.md (~101-103) is reconciled so review_run_start/review_pass_set/finding_add are documented as reviewerWrite / lease-exempt to match command-policy.ts
