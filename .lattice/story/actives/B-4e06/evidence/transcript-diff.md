# B-4e06 real-machine acceptance — transcript & diff

Rhythm: PLAN outcome = expected → run on a real machine → actual → diff.

## Build / suite evidence
- `npm --prefix packages/main run build` → tsc clean.
- `npm --prefix packages/main run test:verification-intent-repair-smoke` → 11/11 PASS.
- `node scripts/verify-init-check-bootstrap.mjs all` → PASS (help-health, concurrent, nested-gitroot, invalid-gitroot, branch-isolation, branch-not-polluted, dry-run, scoped-stage, bad-branch).
- `node scripts/verify-story-review-structured-output.mjs` → PASS (missing-intent, advisory-only, high-risk, legacy-evidence-no-intent).
- `lattice validate --story=B-4e06 --json` → allPass, 23/23 covered, missingRequired=0.

## CHK-001 — verification_intent_repair (real CLI)
**Expected:** an audited repair command exists; fail-closed preflight; runs in DEV.
**Actual (this worktree, story B-4e06):**
```
lattice verification_intent_repair --storyId=B-4e06 --mode=fromEvidence \
  --legacyRepair=true --reason="…(≥30 chars)…" --dryRun --takeover
→ [DRY-RUN] verification_intent_repair (fromEvidence) for B-4e06
  No missing verificationIntent lanes with passing evidence — nothing to repair.
```
Missing `legacyRepair` → "legacyRepair must be explicitly true"; reason "too short" → "reason 必须 ≥ 30 字符"; the command is owner-gated (storyScopedMutating) — it refused until `--takeover` transferred the stale lease.
**Diff:** matches expected.

## CHK-002 — story_review + validate name the repair path (integration)
**Expected:** missing intent stays a hard blocker; when evidence exists without intent, both surfaces name `verification_intent_repair`; the hint is never a pass condition.
**Actual:** `verify-story-review-structured-output.mjs legacy-evidence-no-intent` proves story_review returns a `missing_verification_intent` blocker with `legacyEvidenceWithoutIntent=true` + `repairCommand=verification_intent_repair`; a no-evidence lane keeps the generic blocker; `validate --json` returns a `legacyEvidenceWithoutIntent` array naming CHK-001 happy. Coverage math (missingRequired) is unchanged.
**Diff:** matches expected.

## CHK-003 — gitRoot worktree bootstrap (integration)
**Expected:** a wrapper-root project (metadata root not git, real repo at configured gitRoot) can enter INIT_CHECK; invalid gitRoot fails closed; plain repos unchanged.
**Actual:** `verify-init-check-bootstrap.mjs nested-gitroot` → worktree + story branch created inside the configured gitRoot, wrapper root has no `.git`, metadata under the configured storyDir inside the gitRoot. `invalid-gitroot` → fails closed with the signed-workspace reason, no worktree created. The 5 plain-repo scenarios stay green (getRepoRoot fallback unchanged).
**Diff:** matches expected.

## CHK-004 / CHK-005 — smokes + docs + build
**Expected:** focused smokes; `checklist_update --help` healthy; docs synced; build exposes the new command.
**Actual:** new `tasks/verification-intent-repair-smoke.ts`; bootstrap `help-health` mode asserts `checklist_update --help` exits zero; the decision doc gained a "Delivered (B-4e06)" section (doc reviewer verified every claim against the code); command-ownership (221 cmds) + lifecycle-registry (0 divergences) + process-fact contracts pass, proving the dist CLI exposes `verification_intent_repair` correctly.
**Diff:** matches expected.

## Conclusion
verdict: accepted. Every scenario matches the PLAN expectation; no diffs. Both ClawCreek dead-ends (evidence-without-intent, gitRoot wrapper bootstrap) are closed without weakening the second-generation flow.
