# CHK-001 Source Inventory — B-1148

Produced by mechanical scan of `.koala/story/actives/*/summary.json`, `~/.koala/dev-memory/experience.jsonl`, and `docs/requirements/decisions/*.md`. No chat-memory facts invented.

---

## Existing Dev-Memory (5 entries, all global scope, all from B-ad2c)

| id | category | summary |
|----|----------|---------|
| 7bc20e5 | workflow | 普通编程会话先加载经验再开发 |
| 2de5d6b | tool-quirk | Koala 自举开发时全局 CLI 可能滞后 |
| c948c85 | failure-mode | Reviewer evidence 不能用非 main 近似判断 |
| f4fe749 | workflow | Delivery review 应绑定文档承诺和真机输出 |
| a6832a1 | failure-mode | Reviewer 不应抢 owner-gated story 命令 |

Source: `~/.koala/dev-memory/experience.jsonl` (verified via `cat`)

---

## source-inventory: backfill/duplicate/skip/needs-human-confirmation

### Candidate 1 — Owner lease: ppid instability in Claude Code
- **status**: `backfill`
- **topic**: CLAUDE_CODE_SESSION_ID vs derived-ppid instability — each Claude Code Bash call spawns a fresh shell, so ppid changes between calls; CLAUDE_CODE_SESSION_ID is the reliable anchor
- **source refs**: `.koala/story/actives/B-c55d/summary.json` (pitfalls field), `docs/requirements/decisions/session-ownership-and-write-leases.md`
- **rationale**: Directly operational — any agent using owner-lease commands needs to set KOALA_SESSION_ID or rely on CLAUDE_CODE_SESSION_ID; not covered by existing entries

### Candidate 2 — Owner lease: fail-closed non-crypto coordination
- **status**: `backfill`
- **topic**: Story owner lease is a local process-coordination id, not a cryptographic identity. Non-owner sessions hitting storyScopedMutating commands fail-closed. Stale threshold 30 min; --takeover for stale, --forceTakeover for active override
- **source refs**: `.koala/story/actives/B-c55d/summary.json` (changes + expectedOutcome), `docs/requirements/decisions/session-ownership-and-write-leases.md`
- **rationale**: Workflow-critical — agents regularly encounter owner-lease errors and need to understand the takeover/forceTakeover distinction; not covered by existing `a6832a1` (which is about reviewer not seizing, not the general takeover flow)

### Candidate 3 — Main write lock: reentrancy deadlock prevention
- **status**: `backfill`
- **topic**: DONE flow runs audit inside the lock; without reentrancy registry this causes self-deadlock. Solution: in-process held-lock registry + same-root pass-through
- **source refs**: `.koala/story/actives/B-f60c/summary.json` (pitfalls field)
- **rationale**: Rare but catastrophic if hit; not covered by existing entries

### Candidate 4 — Pre-push hook: packages/main build before recursive tsc
- **status**: `backfill`
- **topic**: packages/utils source imports packages/main/dist compiled output. If packages/main is not built first, recursive tsc scan hits utils and fails with module-not-found before any real type error is detected
- **source refs**: `.koala/story/actives/B-eab3/summary.json` (pitfalls field), `.koala/story/actives/B-eab3/delivery-check.json`
- **rationale**: High-frequency operational pitfall for Koala self-development; not covered by existing entries

### Candidate 5 — Pre-push hook: fail-closed when node missing
- **status**: `backfill`
- **topic**: The pre-push hook uses node to parse package.json to identify koala self-hosting repos. If node is missing, it must fail-closed (exit 1) not fail-open (exit 0), otherwise the entire tsc gate is silently bypassed
- **source refs**: `.koala/story/actives/B-eab3/summary.json` (pitfalls field)
- **rationale**: Defensive gate design principle; novel lesson not covered by existing entries

### Candidate 6 — INIT_CHECK fallback/repair: explicit acknowledge+reason required
- **status**: `backfill`
- **topic**: `koala init_check_repair` for environments that cannot spawn an INIT reviewer requires `acknowledge:true` and `fallbackReason≥30 chars`. Omitting either causes a rejected request with no file written. The @fallback suffix in agentResults makes human-attest mechanically distinguishable from independent reviewer
- **source refs**: `.koala/story/actives/B-95d8/summary.json` (changes + expectedOutcome + limitations), `.koala/story/actives/B-95d8/plan.md`
- **rationale**: Operationally important for CI/sandbox environments; not covered by existing entries

### Candidate 7 — Evidence quality: shallow commands do not pass strict verification gates
- **status**: `backfill`
- **topic**: Strict workflow profiles surface weak evidence (shallow natural-language claims, weak commands like `echo done`, self-verification, stale CI/human claims, revoked actors). A story with only prompt-only claims cannot pass strict evidence gates
- **source refs**: `.koala/story/actives/B-1fca/summary.json` (expectedOutcome + changes)
- **rationale**: Cross-cutting operational lesson; partially overlaps with `c948c85` (reviewer evidence classification) but covers a broader category of evidence weakness; distinct enough to warrant its own entry

### Candidate 8 — Flow fact policies: pass-only finding_add normalized to review_pass_set
- **status**: `backfill`
- **topic**: A reviewer that calls `finding_add` with a pass-only body (low severity, koala-review-* agent, no failure language) is automatically normalized to `review_pass_set` by flow-policy:pass-only-normalization. This prevents misclassified "no findings" records from polluting the open findings list
- **source refs**: `.koala/story/actives/B-9b8f/summary.json` (expectedOutcome + pitfalls), `.koala/story/actives/B-9b8f/delivery-check.json`
- **rationale**: Reviewer interaction pattern; not covered by existing entries; critical to avoid confusion when reviewers report "clean"

### Candidate 9 — Reviewer lane: reviewRunId required to bind finding or pass evidence
- **status**: `backfill`
- **topic**: Reviewers must call `review_run_start` first and include the returned `reviewRunId` in subsequent `review_pass_set` or `finding_add`. A legacy-signed record retrofitted with a fresh run id is rejected. This prevents prompt-only, stale context, or wrong-lane claims from satisfying REVIEW
- **source refs**: `.koala/story/actives/B-ad12/summary.json` (changes + expectedOutcome)
- **rationale**: Not covered by existing `c948c85` (which is about main-agent vs reviewer classifier, not the run-start protocol)

### Candidate 10 — riskSignal dismiss: dismiss auto-elevated false positives to remove gate cost
- **status**: `backfill`
- **topic**: `story_create` auto-elevates stories that mention (not modify) risky keywords. Use `story_review_dismiss` to dismiss false-positive riskSignal categories. Once all auto-elevated signals are dismissed, `priority` rolls back to `priorityElevatedFrom` and high-risk gates (missing_decision, ≥3 preMortem) are lifted
- **source refs**: `.koala/story/actives/B-30b2/summary.json` (changes + expectedOutcome + usage), `.koala/story/actives/B-30b2/delivery-check.json`
- **rationale**: Frequently encountered operational friction; the dismiss path is non-obvious; not covered by existing entries

### Candidate 11 — Cross-story gate bypass: individually-correct stories can combine to produce a critical bypass
- **status**: `backfill`
- **topic**: B-cf60 (declared artifact declaration) and B-4b22 (dirty-gate-policy marking declared_artifact_changes non-blocking) each passed single-story REVIEW independently. After merging to main, the combination allowed an agent to `artifact_declare` a source file to reclassify it from blocking to non-blocking, bypassing the DONE dirty gate. Root cause: single-story reviews cannot see cross-story interactions. Mitigation: combination review for parallel framework stories
- **source refs**: `.koala/story/actives/B-8db9/summary.json` (pitfalls + description), `docs/requirements/decisions/story-lifecycle.md#combination-review`, `.koala/story/actives/B-da14/summary.json`
- **rationale**: High-impact architectural lesson about parallel framework story risk; not covered by existing entries

---

## Duplicate / Skip — Covered by Existing Entries

| topic | existing entry | rationale |
|-------|---------------|-----------|
| Session start preflight workflow | 7bc20e5 (B-ad2c) | Direct duplicate — same lesson |
| Koala self-hosting CLI dist lag | 2de5d6b (B-ad2c) | Direct duplicate — same lesson |
| Main-agent findings not valid reviewer evidence | c948c85 (B-ad2c) | Covered — classification boundary |
| Delivery review linking docs promises to transcript | f4fe749 (B-ad2c) | Direct duplicate |
| Reviewer seizing owner-gated commands | a6832a1 (B-ad2c) | Covered — reviewer lane boundary |
| B-4bd4 authority client role (PD-1/PD-2) | skip | Highly specialized design doc; no operational reuse pattern worth a dev-memory entry |
| B-8596 session ownership doc adoption | skip | Covered by candidates 1-2 via B-c55d; adoption story itself has no novel lesson |
| B-3506 auto-commit Koala metadata | skip | Operational implementation detail, no cross-project reuse value |

---

## Needs Human Confirmation — No Story Artifact Available

These topics are referenced in CLAUDE.md or decisions docs but have no readable story artifact (no `.koala/story/actives/<id>/` directory in this worktree). Cannot produce backfill entries without human verification of primary source.

| topic | claimed source | why no artifact | recommendation |
|-------|---------------|-----------------|----------------|
| INIT_CHECK anti-forgery gate design (signature domain, guard-utils layers, EXP-001 proof) | B-e71f (CLAUDE.md §"INIT→INIT_CHECK 硬门槛") | No `B-e71f` directory in `.koala/story/actives/` | Human confirm story artifact location; if available, capture gate design lessons |
| Open Questions (OQ) channel — contradictions between description and decisions get an OQ id that main agent must resolve | B-ed3e (CLAUDE.md §"Open Questions") | No `B-ed3e` directory in `.koala/story/actives/` | Human confirm; CLAUDE.md text is sufficient for a docs_check ref if confirmed |
| story_draft gate (draft-check.json, two-phase story creation) | B-9975 (CLAUDE.md §"story_create 前置 draft gate") | No `B-9975` directory in `.koala/story/actives/` | Human confirm story artifact location |
| Framework audit / fake DONE bug root cause (B-9bd9 — single-root tsconfig misses subpackages) | B-9bd9 (CLAUDE.md §"pre-push hook") | No `B-9bd9` directory in `.koala/story/actives/` | Partially covered by B-eab3; human confirm B-9bd9 artifact for the fake-DONE aspect |
| Dispatch unification: koala dispatch replacing story_dispatch/finding_dispatch | B-9d95 (CLAUDE.md §"Cluster 聚簇") | No `B-9d95` directory in `.koala/story/actives/` | Human confirm; no reusable lesson beyond "use koala dispatch" which is already documented |
| Recursive tsc gate original story | B-5a28 (CLAUDE.md §"pre-push hook") | No `B-5a28` directory in `.koala/story/actives/` | Partially covered by B-eab3 (which fixed B-5a28's unkept promise); no separate entry needed if B-eab3 entries are captured |

---

## Summary Counts

- DUPLICATE / SKIP: 8 topics (no capture needed)
- BACKFILL candidates: 11 (all have story artifact refs)
- NEEDS HUMAN CONFIRMATION: 6 (no capture without human verification)

---

*Generated by koala-implementer (B-1148 CHK-001). Sources: mechanical scan only.*
