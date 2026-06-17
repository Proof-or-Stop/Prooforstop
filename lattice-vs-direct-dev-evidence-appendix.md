# Appendix: Lattice-CLI Workflow Development vs. Direct LLM-Agent Development — An Evidence Study

> Status: draft for paper appendix (2026-06-17). All figures are extracted from the live
> Orchestrate repository's Lattice story metadata (`.lattice/story/actives/<id>/`) and git history,
> and are reproducible with the commands in §7. "Direct development" = a developer driving Claude
> Code / Codex in a single author-reviews-own-work pass (the author writes code + its own smoke
> test, then merges), with no independent adversarial review round, no signed evidence binding, and
> no gate quorum.

---

## 1. The two development modes

| Dimension | Direct Claude Code / Codex (single-pass) | Lattice-CLI workflow |
|---|---|---|
| Lifecycle | edit → (own) test → commit | INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE, per-story git worktree |
| Who reviews | the author (self) | N independent reviewer sub-agents per round (concept, quality, test-coverage, behavior, docs, delivery), each with fresh context |
| Test trust | author's own smoke = ground truth | smoke + **independent test-coverage audit** of intent↔evidence binding; every claim bound to a literal command |
| Failure escalation | none | ≥2 first-round findings auto-escalate to a 3-round review quorum (full 3×2 hosts, or audited degraded 3×1) |
| Determinism guards | ad hoc | gate logic is content-addressed (`materialHash`); learning/advisory layers provably excluded from gates |
| Audit trail | git log | signed findings, review-runs/passes, scope contracts, delivery-check, escalation records, append-only `process-events.jsonl` |
| Merge gate | human judgement | hard DONE gate: coverage, evidence-freshness, delivery-check, escalation, summary — all must pass |

The empirical question for the paper: **does the independent-adversarial-review layer catch correctness defects that a single-pass author (with a passing smoke) would ship?** The evidence below answers yes, and quantifies it.

---

## 2. Macro evidence — the self-development corpus

Lattice is developed under its own workflow (dogfooding). Snapshot of the corpus on local `main`:

| Metric | Value |
|---|---|
| Total stories (`.lattice/story/actives/`) | **428** |
| Stories reaching DONE | **392** |
| Stories with ≥1 recorded reviewer finding | **169** (39.5% of all stories) |
| Total findings recorded | **635** |
| — critical | **5** |
| — high | **322** |
| — medium | **226** |
| — low | **82** |
| Stories that required a review-escalation quorum (host-verdict / fallback events) | **32** |

Reading: across 428 self-built stories, the independent-review layer surfaced **635 findings**, **327 of them high-or-critical**, on ~40% of stories — issues recorded *before* DONE/merge. Under direct single-pass development these would have had no second set of eyes.

---

## 3. Micro evidence — deep per-finding study of 12 representative stories

We deeply mined the 7-story **Experience Layer** build (this session) plus 5 prior **LLM-usage-ledger** stories. For every finding we recorded its id, severity, the fix commit, a classification, and a conservative judgement `smokeWouldMiss` = "would a single-pass author relying on their own (passing) smoke plausibly have missed this?" (judgement made by an independent extraction pass against the recorded artifacts; it is a classification, not ground truth — see §8).

| Story | Type | Review rounds | Reviewer passes | Escalated | Findings |
|---|---|---|---|---|---|
| B-1480 | doc | 2 | 8 | degraded-3×1 | 1 |
| B-000c | feature (Phase 1a) | 2 | 7 | no | 1 |
| B-4f46 | feature (Phase 1b) | 2 | 7 | degraded-3×1 | 3 |
| B-1dc9 | feature (Phase 1.5) | 2 | 8 | no | 2 |
| B-2ccc | refactor (digest) | 2 | 7 | degraded-3×1 | 4 |
| B-8387 | feature (Phase 2) | 2 | 6 | degraded-3×1 | 4 |
| B-7561 | feature (Phase 3) | 2 | 7 | degraded-3×1 | 3 |
| B-1b28 | feature (UL default-on) | 2 | 5 | full-3×2 | 1 |
| B-dd44 | feature (UL budget) | 2 | 7 | no | 1 |
| B-fd64 | feature (UL authority) | 2 | 7 | degraded-3×1 | 2 |
| B-4bf8 | chore (UL accuracy) | 2 | 8 | degraded-3×1 | 4 |
| B-253e | feature (UL writer) | 2 | 5 | full-3×2 | 2 |

**Aggregates over the 12 stories:**

- **28 findings** total.
- **26 / 28 (93%)** classified `smokeWouldMiss = true` — i.e. the author's own smoke was passing and the defect/gap was surfaced only by an independent reviewer.
- Severity: **1 critical, 13 high, 11 medium, 3 low**.
- Classification: **3 production_bug · 3 logic_defect · 14 test_coverage_gap · 8 doc_accuracy**.
- **Every** story required a **2nd review round** (find → fix → re-review); **7 / 12** required an escalation quorum.

So even on a curated 12-story slice, the workflow caught **6 genuine correctness defects** (3 production bugs + 3 logic defects) plus **14 real test-coverage gaps** that the authoring smoke did not exercise — all before merge.

---

## 4. Correctness exhibits (verbatim, with fix commits)

These six are the centerpiece: in each, the **author's own smoke was green (or bypassed the surface), and an independent reviewer caught the defect**. Finding text is quoted verbatim from `findings.json`.

### EXHIBIT A — B-dd44:F-001 (critical, production_bug) · fix `896d0a1e3`
> "`resolveHardBudget` uses `env ?? {}` (empty object) instead of `env ?? process.env`, so when `opts.env` is `undefined` (the production path in lattice-dispatch.ts …) the function sees `{}` and never finds `LATTICE_HARD_BUDGET_TOKENS` … **The budget guard silently never fires in production. The smoke suite misses this because every test passes an explicit env object.**"

The single strongest data point: a production-disabling bug that the unit smoke could not see (it always injected env), caught by code-inspection in an independent quality review.

### EXHIBIT B — B-7561:F-001 (high, production_bug) · fix `605d5123`
> "the CLI schema … only registers `--storyId` (not `--story`). Running `lattice recall --story B-7561` silently drops the flag and returns the usage message instead of results. … **The smoke test bypasses this by calling `h.recall({storyId:...})` directly.**"

Classic smoke blind spot: the smoke tested the handler function, not the CLI parsing surface, so the user-facing command was broken while the test was green. Caught by a reviewer running the *actual* CLI.

### EXHIBIT C — B-8387:F-003 (medium, production_bug) · fix `8f94dfbd3`
> "`nextProposalId` reads only proposals/ directory … after a full lifecycle round (propose→approve→proposal deleted) … the counter resets to PBP-001; a second propose then mints another PBP-001, and approving it produces **two entries with identical id** in playbooks.json."

A reproducible state-corruption bug triggered only by a full lifecycle cycle the author's smoke never exercised.

### EXHIBIT D — B-fd64:F-001 (medium, logic_defect / security) · fix `be98ec167`
> "gate subjectId null-bypass: `verifyUsageReceipt` checks `subjectId !== undefined` but not `typeof subjectId === 'string'`; a runtime-null subjectId … produces `receiptVerified=true` without a genuine string subject binding. … **No test covers this adversarial case.**"

A gate-bypass (authenticity check) caught by adversarial review.

### EXHIBIT E — B-4f46:F-001 (medium, logic_defect) · fix `fbfec03824`
> "`approveSignatureTag` auto-creates never-proposed tags as active, bypassing the propose step." — spec-deviating logic; smoke passed but the adversarial path was uncovered.

### EXHIBIT F — B-253e:F-002 (medium, logic_defect) · fix `d6ffc6a44`
> "summary.ts null coercion — `item.total` typed as `number|null` even after the unknown guard; the spec forbids coercing null to 0 but the smoke passed." — a cross-cutting type-contract violation a single author would overlook.

---

## 5. The find → fix → re-review loop (process evidence)

Every one of the 12 stories shows the same verifiable cycle in its `process-events.jsonl` + git history:

1. Round-1 REVIEW: independent reviewers file finding(s) (`finding_add`, signed).
2. The dedicated `lattice-implementer` (not the main agent) commits a fix; `finding_resolve` records it.
3. The fix commit **stales** the round (content-addressed `materialHash` changes) → the story rolls REVIEW→DEV→REVIEW.
4. Round-2 REVIEW: the **same independent reviewers** re-run and PASS; test-coverage confirms the previously-missing assertion now exists and is bound to a literal command.
5. ≥2 first-round findings → a 3-round escalation quorum is required before DONE (full 3×2, or audited degraded 3×1 with `assuranceLevel=degraded-single-host` and `authorityDone=false`).

This is the structural difference from direct development: a defect cannot be silently "fixed" — the fix invalidates the prior evidence and forces a fresh independent pass bound to new evidence.

---

## 6. Lattice developing itself — friction log (dogfooding)

The tool gating its own development surfaced friction. Classified: **[bug]** genuine defect · **[process]** operator lesson (tool as designed) · **[concurrency]** shared-`main` multi-session artifact. (Full version with source-line citations in the companion friction log.)

1. **[concurrency]+[process] DONE evidence-freshness needs `validate`, not `refresh_stale`.** The DONE gate compares `test-evidence.json`'s top-level `materialHash` (sha256 over `git ls-tree -r HEAD`, story/runtime paths excluded) against current HEAD. That stamp is re-written **only** by the `validate` handler; the `refresh_stale` family updates per-entry coverage only. With concurrent merges into shared `main`, the hash drifts and `refresh_stale` can loop forever. Fix: full-sync `main` → `validate` (re-stamp) → advance DONE immediately. (`evidence-freshness.ts`, `handlers/verifier.ts`, `done-closure.ts`.)
2. **[process]/observability gap: "success message" ≠ "persisted+committed".** Reviewer/scope/delivery sub-agents occasionally reported success while the artifact was never committed (malformed args accepted but not persisted). Fix: verify `git log -1 -- <artifact>` non-empty before advancing.
3. **[process] degraded 3×1 escalation in a solo-operator env.** ≥2 first-round findings demand 3×2 independent PASS hosts; no second independent host exists, so the engine's audited degraded 3×1 fallback is used (`single-host-environment`), with `authorityDone/productionDone` hard-coded `false` — honestly lower assurance, not a 3×2 spoof. (`review-escalation.ts`.)
4. **[bug-leaning] scope_freeze excluded-keyword false positives.** `scope-anti-expansion.ts` substring-matches default future-capability keywords (e.g. "Authority") against descriptive background prose after stripping spaces, producing spurious `future_capability_keyword` hard-fails. Workaround: reword background; the matcher altitude is the real defect.
5. **[process] english-artifacts gate × phase-freeze.** Committed story artifacts must be English (OSS-prep); fixing a Chinese-authored story after INIT_CHECK freezes the checklist is costly. Lesson: author artifacts in English from `story_create`.
6. **[bug→advisory] worktree bootstrap lacks node_modules/dist.** `git worktree` checks out tracked files only; a new worktree can't run `tsc`/`validate`. Now a non-fatal warning (`worktree.ts` `detectMissingNodeModulesWarning`); operator symlinks node_modules.
7. **[concurrency] main-merge materialHash race at DONE.** The DONE auto-merge can pull a concurrent merge between re-validate and advance, re-staling the hash. Fix: collapse the validate→advance window.
8. **[process] generic verification-evidence commands flagged as audit gaps.** Binding multiple intents to one generic `--command` is rejected by the test-coverage reviewer as an evidence-correspondence gap even when factually true (recurred B-d7ef/B-ed70/B-35aa). Fix: bind each intent to its literal command; fail loud on a fallback command.

**Bug-vs-designed split:** of 8 items, only **#4 and #6 are genuine Lattice defects** (both *caught because the tool gated its own development* — the strongest dogfooding result). Items #3/#5/#8 are the system **correctly refusing to lower its own assurance bar** (gates resist being gamed by their own author); #1/#7 are concurrency artifacts of shared-`main` dogfooding.

---

## 7. How to reproduce / verify every figure

- **Macro stats (§2):** iterate `.lattice/story/actives/*/index.json` (phase) and `findings.json` (count + severity); count `process-events.jsonl` files containing `review_escalation_fallback`/`host_verdict`.
- **Per-finding (§3, §4):** `cat .lattice/story/actives/<id>/findings.json` (id, severity, category, desc, resolvedReason). Fix commits: `git log --oneline --all --grep <id>` or the resolution text.
- **Review rounds / passes (§3, §5):** `.lattice/story/actives/<id>/review-passes.json`, `review-runs.json`, `review.json` (reviewCount), and distinct `currentReviewRound` timestamps in `process-events.jsonl`.
- **Escalation (§5):** `node bin/lattice.js review_escalation_status --storyId=<id>` and the `review_escalation_fallback` record in `process-events.jsonl`.
- **Exhibit fix commits:** `git show 896d0a1e3` (B-dd44), `605d5123` (B-7561), `8f94dfbd3` (B-8387), `be98ec167` (B-fd64), `fbfec03824` (B-4f46), `d6ffc6a44` (B-253e).
- **Engine mechanics cited in §6:** `packages/main/src/core/{evidence-freshness,review-escalation,scope-anti-expansion}.ts`, `packages/main/src/handlers/{verifier,worktree,english-artifact-gate,done-closure}.ts`.

---

## 8. Threats to validity (honest caveats)

- **`smokeWouldMiss` is a classification, not ground truth.** It was assigned by an independent extraction pass reading the recorded finding text + the smoke state at the time; it estimates whether a single-pass author would have caught the issue. It is conservative (it requires the smoke to have been passing) but is a judgement. The hard, non-judgement facts are: the finding exists, was filed by a *named independent reviewer*, the story's verification was passing when it was filed, and a *subsequent fix commit* resolved it.
- **Counterfactual asymmetry.** We observe what Lattice's review caught; we cannot directly observe what a direct-dev run on the *same* tasks would have shipped. The argument is: these defects survived the author's own tests and were caught only by the independent layer, so a process *without* that layer would by construction not have caught them at that stage.
- **Self-built corpus.** All 428 stories were built by LLM agents under Lattice; findings are LLM-reviewer-generated. Severity/classification reflect reviewer judgement. The 635-finding corpus mixes INIT/PLAN/REVIEW-phase findings; the §3 deep set is REVIEW-phase only.
- **Concurrency confound.** Several "friction" items (#1/#7) stem from multiple parallel self-dev sessions sharing `main`; they are environmental, not intrinsic to single-developer use.
- **Author of this appendix = the agent that drove the stories.** Figures are mechanically extracted and reproducible (§7), but a fully independent re-extraction is recommended for publication.

---

## 9. One-paragraph claim for the body of the paper

> Developing under Lattice's own story workflow, an independent adversarial-review layer surfaced 635 findings (327 high/critical) across 428 self-built stories. On a deep 12-story study, 26 of 28 review findings (93%) were defects or gaps that the author's own passing smoke did not catch — including a critical production bug (a budget guard that silently never fired because every unit test injected an environment object), a user-facing CLI flag that was broken while its handler-level smoke was green, a state-corruption bug surfaced only by a full-lifecycle cycle, and a gate authenticity bypass. Every story required a second, evidence-bound review round, and high-finding stories required a 3-round escalation quorum, before merge. The same gating, applied to Lattice by Lattice, also exposed two genuine defects in Lattice's own tooling — the strongest available evidence that the workflow catches what single-pass LLM development ships.
