# session_brief structured experiment v1

Baseline candidate: c01-current
Baseline normalizedScore: 1
Best candidate: c01-current (Current Full Output)
Best normalizedScore: 1 (+0)
Recommendation: no production change; baseline remains best by score
Best compression candidate: c07-next-pending-only (Checklist Next Pending Only) normalizedScore 0.9781, lengthDelta -1301

## Top 3

| rank | candidate | normalizedScore | score | lines | lengthDelta | status |
|---:|---|---:|---:|---:|---:|---|
| 1 | c01-current Current Full Output | 1 | 0.6 | 51 | 0 | rejected |
| 2 | c10-detailed Detailed | 0.9919 | 0.5919 | 58 | 297 | rejected |
| 3 | c07-next-pending-only Checklist Next Pending Only | 0.9781 | 0.5781 | 24 | -1301 | rejected |

## All candidates

| candidate | normalizedScore | score | normalizedDelta | lines | lengthDelta | notable contentSummary |
|---|---:|---:|---:|---:|---:|---|
| c01-current Current Full Output | 1 | 0.6 | 0 | 51 | 0 | has nextStep |
| c10-detailed Detailed | 0.9919 | 0.5919 | -0.0081 | 58 | 297 | has nextStep |
| c07-next-pending-only Checklist Next Pending Only | 0.9781 | 0.5781 | -0.0219 | 24 | -1301 | has nextStep |
| c02-next-step-top Next Step First | 0.9775 | 0.5775 | -0.0225 | 18 | -1239 | has nextStep |
| c05-reviewer-artifact-combined Reviewer And Artifact Combined | 0.9775 | 0.5775 | -0.0225 | 20 | -1292 | has nextStep |
| c04-git-risk-first Git Risk First | 0.9772 | 0.5772 | -0.0228 | 23 | -1259 | has nextStep |
| c08-active-story-card Active Story Card | 0.9769 | 0.5769 | -0.0231 | 20 | -1325 | has nextStep |
| c03-action-dashboard Action Dashboard | 0.9757 | 0.5757 | -0.0243 | 28 | -1194 | has nextStep |
| c06-exception-only-health Exception-only Health | 0.8534 | 0.5034 | -0.1466 | 19 | -1390 | has nextStep; missing runtimeHealth |
| c12-chinese-action Chinese Action Style | 0.8513 | 0.5013 | -0.1487 | 16 | -1359 | missing nextStep |
| c11-product-language Product Language | 0.8492 | 0.4992 | -0.1508 | 17 | -1199 | missing nextStep |
| c09-minimal Minimal | 0.3531 | 0.2031 | -0.6469 | 6 | -1669 | missing phase; missing checklist; missing reviewerStatus; missing artifactStatus |

## Recommendation

Recommended implementation candidate: **none yet**. The current baseline remains the best-scoring output.

Why: current output already preserves all must-keep signals (active story/phase, reviewer/artifact status, git dirty, runtime health, next step).
If we choose to optimize for brevity, the best lower-length candidate is **c07-next-pending-only Checklist Next Pending Only**, but it should be dogfooded before implementation.

Do not implement directly from the highest machine score alone; use this report as design input for a follow-up production story.

## Baseline sample

```text
[0.0s] running session_brief...
[0.2s] session_brief done
# proof-or-stop session brief

**Story**: B-ff27 — 用 lattice-lab 跑 session_brief 结构化候选实验
**Phase**: DEV

## Checklist (0/3 done)
  next pending: CHK-001 准备 session_brief baseline 与 12 个候选样本 (+2 more)

## Runtime health
  [✓] worktree registered — /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ff27

## Reviewer status
  [✓] story review (required) — pass (0 blocker)
  [!] test-intent review (advisory) — missing (0/9 pass, 9 missing, 0 fail)
  [!] implementation review (advisory) — missing
  primary: implementation review → missing

## Recent activity (last 3)
  2026-04-19T00:44:32.049Z session_brief [codex/main/ok]
  2026-04-19T00:43:11.747Z session_brief [codex/main/ok]
  2026-04-19T00:42:52.297Z story_advance [codex/main/ok]

## Git
  recent commits:
    69654e7 lattice: story B-ff27 init
    ea04165 merge: B-780e 为 lattice-lab 增加 session/story review 流程量化 profile
    78668cd lattice: mark B-780e DONE + clear worktree
  uncommitted (8):
    M docs/story/actives/B-ff27/checklist.json
     M docs/story/actives/B-ff27/index.json
    ?? docs/story/actives/B-ff27/decision.json
    ?? docs/story/actives/B-ff27/review.json
    ?? docs/story/actives/B-ff27/understanding.json
    ?? experiments/candidates/
    ?? experiments/reports/
    ?? scripts/run-session-brief-experiment.mjs

## Artifacts
  [✓] understanding (required) — present
  [✓] decision (required) — present
  [✓] story review (required) — present
  [✓] test-intent review (advisory) — present
  [!] implementation review (advisory) — missing
  [!] test evidence (advisory) — missing
  [!] summary (advisory) — missing

## → Next step
  DEV 阶段。下一项：checklist_update --storyId=B-ff27 --itemId=CHK-001 --status=in_progress（准备 session_brief baseline 与 12 个候选样本）
```
