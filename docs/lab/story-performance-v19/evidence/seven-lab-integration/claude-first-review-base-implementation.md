# Independent audit — first-review-base repair (bounded implementation audit)

## Verdict: **APPROVE**

Read-only. No production file, Story artifact, commit, or evidence record was created or modified by me. Disposable probes were built under `/tmp` and deleted; `git status` shows the same candidate files before and after, and every file I audited is byte-unchanged since before this audit began (mtimes ≤ 15:36 UTC, digests pinned below).

Scope: the implementation of `FIRST-REVIEW-BASE-PLAN.md` amendments 1–7 only. Not an approval of the seven-Lab release; unrelated identity-witness reconciliation is pending and is explicitly excluded (see §5).

---

## 1. Commands actually executed, and results

All from the worktree root `/Users/jek/Documents/GitHub/Prooforstop/.worktrees/Lab-performance-main-release-0317`.

| Command | Result |
|---|---|
| `node packages/main/dist/tasks/review-incremental-context-smoke.js --first-base-only` | **PASS** — `LEGACY_FIRST_BASE_DIGEST=ad06de9687d644e7ce6b50c9d2d7aa15428becb0f59e3594da158d7322493935`, then `FIRST-REVIEW-BASE GREEN: pinned main, tamper/ref/missing-object refusals, live material refusal, merged-head replay` (3.9 s) |
| `node packages/main/dist/tasks/review-incremental-context-smoke.js --bounded-paths-only` | **PASS** — `BOUNDED-FROZEN-BASE GREEN` + `(f) BOUNDED-PATHS DEGRADATION: cap=512 … cap+1 degrades to the 1-path story diff` |
| `node packages/main/dist/tasks/review-incremental-context-smoke.js --asof-run-only` | **PASS** — `AS-OF-RUN ELIGIBILITY: metadata-only commit preserves H1 envelope; live HEAD probe remains the old path; later material commit mismatches HEAD-based context` |
| `node packages/main/dist/tasks/reviewer-batch-smoke.js` | **PASS** — `FIRST_FINDING_STORY_DRIFT_REVIEW_REQUIRED`, `FIRST_FINDING_MAIN_DRIFT_REVIEW_REQUIRED`, `reviewer_batch smoke passed` |
| `node scripts/verify-process-fact-contract.mjs` (extra) | **PASS** — `Process fact contract verified` / `Process-fact contract verification passed` |

Additional runs I performed beyond the requested four are reported in §4.

`dist/` was already built from the candidate tree (dist 16:37 local > newest src 16:36 local); `fullStoryBaseHead` occurrence counts in `dist`: review-incremental-context 7, prompt-contracts 4, handlers/review-run 3, core/review-run 1, prompt-envelope 1, smoke 9. The built artifacts I executed do carry the change.

## 2. Amendment-by-amendment result

| Amendment | Verified how | Status |
|---|---|---|
| 1 — conditional digest key, no null placeholder, legacy domain untouched | `review-incremental-context.ts:991` spreads the key only when defined; `domainSeparatedDigest` uses `canonicalJsonStringify`, so insertion position is irrelevant. Golden assertion pins the absent-field digest to `ad06de96…`, which matched live. | Satisfied |
| 2 — producer resolves its own base | `resolveFullStoryBaseHead(store, projectRoot, storyId)` exported (`:770`), single `'main'` candidate through `resolveGitCwd`; handler calls it at `handlers/review-run.ts:328` and passes the same value to both context and assembly; no auto-resolution inside generic replay. Contract guard asserts `!producer.includes('args.fullStoryBaseHead')`. | Satisfied |
| 3 — immutable id validated at two layers, refs rejected | `validateFullStoryBaseHead` (`/^(?:[a-f0-9]{40}\|[a-f0-9]{64})$/`) enforced in the contract optional-key path *and* again at the core option path. Smoke rejects `main`, `HEAD`, `''`, 39-hex, uppercase, non-hex at **both** entry points with an **exact** message match. | Satisfied |
| 4 — unresolvable base, both cases | Production: `resolveFullStoryCommitObject` swallows failure → field omitted (smoke renames `main` → `alternate-main` and asserts `undefined`). Replay: throws `FULL_STORY_BASE_UNAVAILABLE: signed comparison base … does not resolve to a commit`, surfaced by `verifyReviewRunPromptEnvelope`'s pre-existing `try/catch` as `incremental eligibility could not be recomputed: …` — a reason distinct from `Prompt Envelope integrity verification failed`. No fallback to `main`, no empty diff. | Satisfied |
| 5 — all three probes, both paths | `fullStoryBaseRef` drives `changedFilesBetweenRenameAware`, `fixtureCaseClosure`, `changedFileStatusesBetweenRenameAware` inside the single `fullStoryDiffContext` closure, which is the sole entry for the first-timer branch (`:1067`) and the bounded-overflow branch (`:1075`). Incremental path still diffs from `prior.run.headHash` (`:1071/1077/1118`) — untouched. Both covered by `--first-base-only` and `--bounded-paths-only`. | Satisfied |
| 6 — original reviewer-batch expectations | `reviewer-batch-smoke.ts` is **unmodified in the working tree**. The only branch change to it (`1734e66861`) converts fixture writes to the brokered native CLI and enriches a failure *message* with `collectReviewerEvidenceState(...).invalid`; the expected values (`quality.state === 'scope-changed'`, `lane.state === 'blocking'`, `blockingFindings === [behaviorFindingId]`) are unchanged. No relaxation; the reverted diagnostic adjustment is absent. | Satisfied |
| 7 — freeze-at-production, not operator prevention | Stated plainly in `docs/validation-performance.md`; matches the code (no ancestry or reachability constraint on the recorded base). | Satisfied |

Both non-blocking notes from the plan re-review were honored: negative cases assert **exact** refusal strings (not prefixes/regexes), and the legacy byte-identical `eligibilityDigest` is a first-class assertion.

## 3. Independent checks of the specific claims

**Strict commit existence.** Confirmed empirically on this machine (git 2.50.1):

```
plain --verify absent hex: [ 'OK', '0000000000000000000000000000000000000000' ]   ← accepted!
commit-peel absent hex:    [ 'ERR', 128 ]
commit-peel HEAD:          [ 'OK', '9c0a6a1cbb0c91a3b6a26a49b1ef89b597bbca64' ]
```

So the older `gitCommitAtRef` path (`rev-parse --verify <ref>`, still used at `:824` for `asOfRef`) really does accept a nonexistent 40-hex string, and `${ref}^{commit}` is the fix. The implementation additionally requires `resolved === input`, so an annotated-tag or any peeling difference also fails closed.

**Signature field flow.** `computePromptEnvelopeId` digests the whole record minus `envelopeId`/`createdAt` (`prompt-envelope.ts:1525`), so the new key participates automatically — no allowlist to forget. Empirically: mutating `fullStoryBaseHead` yields `verifyPromptEnvelopeIntegrity(tampered) === false` and `{ok:false, reason:'Prompt Envelope integrity verification failed'}`, asserted with `deepEqual`. The consumer reads `envelope.fullStoryBaseHead` only, never caller input.

**Legacy compatibility evidence.** `legacy-first-base-compatibility.json` records old digest == new digest == `ad06de96…` against baseline `9c0a6a1cbb`. Its probe transpiles only the *old* `review-incremental-context.ts` and rewires its relative imports to the **current** `dist` modules — disclosed verbatim in the artifact (`"sharedDependencies": "current candidate; only the old context implementation is replayed"`) and in the smoke's golden comment. That bound is honest and, here, sound: the shared-dependency deltas in this candidate are purely additive (one optional key added to an allowlist, one conditional spread), so they cannot change a digest computed with the field absent. I independently reproduced the current-implementation side of that equality (the live `LEGACY_FIRST_BASE_DIGEST` above); I deliberately did **not** re-execute the probe, because it overwrites that artifact in place and I have no way to preserve the original bytes under read-only constraints.

**Moving main / bounded overflow / live freshness.** The first-base case exercises, in order: main advancing before any merge, an unrelated `--no-ff` merge, main later fast-forwarded to *contain* the reviewed commit (so a recomputed merge-base cannot substitute), real Story-source drift, and restoration — asserting historical `ok:true` throughout while `assertCurrentReviewRunForEvidence` still refuses on Story-source drift (`/stale|material/i`) and re-admits after restore. That is the right separation: the freeze moves a historical input only, live admission stays live.

## 4. Findings (all non-blocking)

1. **Two concurrency cases in the same registered suite are red — and are pre-existing, not caused by this candidate.** The full `test:review-incremental-context-smoke` (registered in root `test:serial-reference`) aborts at `runDeterministicTicketReclaimAbaCase` with `timeout waiting for W1 observing dead A`, and `--guard-map-only` fails with `concurrent passes and findings are retained exactly once`. Both reproduce in isolation.
   I attributed this rather than assert it: I built a disposable overlay at `/tmp` from `dist`, replaced the seven changed modules with their **HEAD (`9c0a6a1cbb`) sources** transpiled via the TypeScript API (verified: 0 occurrences of `fullStoryBaseHead` in the overlay's context/handler/contracts/smoke), and re-ran. Both failures reproduce byte-identically without any candidate code. Sanity check on the same overlay: `--asof-run-only` passes. Overlay deleted.
   Code-reachability agrees: at the moment of the ABA timeout, W2 is parked inside lock *acquisition* (`onBeforeStaleTicketRemove`), before the handler body where the new resolution runs; W1 is `agent_prompt`, a path this candidate does not touch. **This belongs to whoever owns the release, not to this repair** — but it means the suite's post-ABA cases (guard-class matrix, concurrent reviewer writes, mutation kill map) never execute in a full run today. Everything that covers *this* change runs before the abort and passed.
2. **The wrapped unavailable-base path is not covered end to end.** The smoke proves the direct throw and the tampered-field refusal, but tampering is caught earlier by envelope integrity, so `incremental eligibility could not be recomputed: FULL_STORY_BASE_UNAVAILABLE …` is never asserted through `verifyReviewRunPromptEnvelope`. That path is reachable in production with a *validly signed* base that later becomes unresolvable (fresh clone, GC, or a history rewrite — a hazard this repo has hit before). Behaviour is fail-closed and correct by inspection; only the assertion is missing.
3. **Producer-side omission is silent and indiscriminate.** `resolveFullStoryCommitObject` catches everything, including the 5 s timeout, so a transient git stall at `review_run_start` is indistinguishable from "no `main`" and silently produces a legacy-shaped envelope. That is the documented intent for "cannot resolve main"; it is worth a follow-up only if you want transient failure distinguished from absence.
4. **Doc/registry text matches behaviour.** The `docs/validation-performance.md` section and the `PROCESS_FACT_ARTIFACTS` rationale both state the conditional binding, the object-id-not-branch rule, the unavailable-base refusal, legacy preservation, and the live-checks separation. No overclaiming — it says "records that choice rather than preventing it".

## 5. Outside this approval boundary

The working tree carries changes unrelated to this repair: `tests/red/red-b49d4-harness-registration.mjs` (dynamic-finding harness registration; its mutation loop now passes each mutant's own digest so the *semantic* markers actually get exercised — a strengthening, and the live positive path still pins `F031_SOURCE_SHA256`), and the identity-cutover manifests. The latter re-pin `REVIEWED_NEGATIVE_SOURCE_INTEGRITY` digests for files this candidate does not modify (`runtime-environment-checks.ts`, `certification-window-smoke.ts`, `review-inventory-handler-smoke.ts`, `verify-proof-or-stop-prompt-baseline.mjs`, `verify-runtime-fact-contract.mjs`); only the `verify-process-fact-contract.mjs` digest follows from this repair. Bulk re-pinning "reviewed" witnesses is exactly the class of move that needs its own review — flagged, not judged here, per the stated pending status.

**Concurrency notice:** four further files (`scripts/identity-reviewed-{source,fixture}-{contexts.mjs,data.json}`) became modified at 16:47 local, mid-audit, by something other than this session — the tree is being edited concurrently. None of them are in any code path I executed, and all nine files I audited are unchanged since 15:36 UTC.

**Approval is bound to these bytes** (sha256, first 16 hex):

```
a5f14a10db6d445f  packages/main/src/core/prompt-contracts.ts
42350dfb0e142ae8  packages/main/src/core/prompt-envelope.ts
d20ed51d202b3549  packages/main/src/core/review-incremental-context.ts
8631abc1bf900f8f  packages/main/src/core/review-run.ts
f957bc27d2fe8b40  packages/main/src/handlers/review-run.ts
e42229120e06aae2  packages/main/src/core/process-fact-registry.ts
2e7182a4219e0102  packages/main/src/tasks/review-incremental-context-smoke.ts
f17def09bf9077b5  scripts/verify-process-fact-contract.mjs
05d5c94d6247c915  docs/validation-performance.md
```
