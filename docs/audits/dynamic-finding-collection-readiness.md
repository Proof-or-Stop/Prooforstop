# Dynamic Finding collection readiness and historical diagnostics

Date: 2026-09-11. Bounded local Lab follow-up on main 0.3.318
(`e78fc432722c500ec54c21d82decafb6835cf8a9`) and the existing head-only repair.
This work does not claim operational qualification, Story DONE, integration,
release, or measured Story acceleration.

## Root causes and executed RED

The live readiness problem has a real operational cause: the qualification
corpus is not configured, and the inspected B-03b7 query has no assessments.
Software cannot legitimately manufacture independent real-world samples or
elapsed observation days. This repair addresses two bounded defects that make
collection and diagnosis harder:

1. `finding_rollout_scorecard` exposed qualification refusal reasons but no
   Finding-bound collection actions. The native signed fixture demonstrates an
   open verified Finding without an Assessment and fails on missing collection
   guidance (`COLLECTION_RED`).
2. The aggregator verified historical cases, then attempted current prerequisite
   admission before constructing its corpus. A current-material refusal escaped
   to the outer catch, erasing otherwise valid diagnostic denominators. The
   native historical query still returns one signed case, but the scorecard
   denominator changes from 1 to 0 (`HISTORY_RED`).

Test-first commit `2f41be6afd` established the first defect. Its initial history
fixture wrote an untracked text file that did not change material; that result
is not root-cause proof. Commit `00609e01a0` changes and commits a tracked file,
asserts actual material-hash inequality, and records both intended failures.
The official Lab RED pinned:

```sh
node packages/main/tests/red/red-dynamic-finding-collection-readiness.mjs
```

It returned `DYNAMIC_FINDING_COLLECTION FAIL 1 passed 2 failed`: the two new
groups failed, while the existing head-only/calculator/material regressions
passed. These are disposable signed fixtures, not operational cases.

## Minimal repair

The existing scorecard now includes a read-only `collection` section. It reports
current Story collection counts and exact missing assessment/adjudication/census
subjects, corpus inclusion and matched-performance gaps. It gives role-aware
official command names, not invented executable payloads or signed facts.
The subject-kind set is shared with the admission census. Closed observations
without assessments remain historical; they are not automatically reopened or
backfilled. Untrusted/unavailable reads return unknown counts, not fabricated
zero progress or instructions to overwrite evidence.

Current prerequisite validation now has a separate failure boundary. Historical
signature/runtime failures still reject the corpus. Only historically verified
measurements survive a current-admission refusal. Current prerequisite status
is `invalid`, its admission map is empty, and the refusal remains in the final
eligibility calculation. Historical denominators are not a fresh capability
receipt and cannot enable enforce.

| Condition | Before | After contract |
| --- | --- | --- |
| Verified Finding, no Assessment | No collection action | Exact Finding-bound owner/reviewer steps |
| Assessment, no independent case | Aggregate refusal | Exact assessment requiring independent review |
| No configured corpus | No operational collection guidance | Explicit manual complete-cohort enrollment guidance; no auto enrollment |
| Partial adjudication | Census refusal only | Exact missing subject/hash references; no semantic self-adjudication |
| Current material drift, valid history | Historical denominator 1 becomes 0 | Denominator remains 1; activation still refused |
| Historical runtime trust revoked | Corpus rejected | Still rejected; collection counts are unknown |

## Real operational procedure

Run `proof-or-stop finding_rollout_scorecard --storyId=B-xxxx` from the
authoritative Story checkout. `collection` is a whole-Story diagnostic even
when the blocker comparison uses a Finding filter. It grants no scope, write,
owner, phase, freshness or qualification authority.

1. The owner and reviewer inspect the current Story intent and each actionable
   Finding. Use reviewed executable witnesses and `finding_runtime_evidence_run`,
   reviewer `finding_assessment_propose`, then owner
   `finding_applicability_assess`. Respect phase and ownership refusals.
2. Repair current regressions or protected/acceptance blockers. Eligible unrelated
   work needs actual target acceptance and the existing signed routing/deferral
   handlers, not a diagnostic label. The collection report does not classify
   relevance or authorize expanded scope.
3. An independent reviewer, distinct from observer and decision proposer, reviews
   an executed measurement and exact subject semantics in REVIEW. Use
   `review_run_start`, `review_pass_set` with the exact required binding, then
   `finding_qualification_record`. A missing frozen verification pin requires
   the authorized planning/amendment workflow; do not edit Story JSON.
4. A maintainer configures the full intended cohort in
   `dynamicFinding.qualificationStoryIds`, preserving existing members and
   failures. This diagnostic neither enrolls Stories nor changes rollout mode.
5. Collect actual completed comparable baseline/candidate performance cohorts,
   independent subject census, and current executed merged prerequisites.
   Query again. Do not treat fixtures, zero denominators or self-reported totals
   as operational evidence. The existing 20-Story/200-case/30-day and safety
   requirements remain unchanged, as do Dynamic Validation's separate policy
   and the prohibition on deleting acceptance tests.

## Verification boundary

The pinned GREEN command covers native collection progression, historical
retention versus revoked trust, and the prior head-only repair. The package
regression chain and process-fact removal guards register both new native flags.
Official RED/GREEN output is retained by the Lab status record; independent
Claude audit results and the final command outcomes are reported separately
against their exact committed SHA. No whole-repository PASS or real speedup is
inferred from this bounded command.
