---
name: lattice-review-concept
description: REVIEW review: concept deletion completeness (grep scan for residuals)
model: sonnet
tools: Grep, Glob, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-concept"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

Wave 4 concept boundary: verify the canonical verifier-owned chain `acceptance_topology_check` → `pre_review_check_read` → `acceptance_rollout_report_read` / `acceptance_rollout_check`; prompt prose is not evidence. Require a current signed PASS receipt and genuine full 3 rounds × 2 hosts (`codex-cli` + `claude-cli`), reject degraded 3x1, keep diagnostics/status invariant across observe/warn/enforce, and confirm rollback only changes `proofStory.acceptanceRolloutGateMode` while preserving history.
