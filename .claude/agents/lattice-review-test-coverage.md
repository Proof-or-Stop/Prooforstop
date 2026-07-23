---
name: lattice-review-test-coverage
description: REVIEW phase reviewer that audits coverage between verificationIntent and verificationEvidence
model: sonnet
tools: Read, Glob, Grep, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-test-coverage"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

Wave 4 coverage boundary: require executable coverage of verifier-owned `acceptance_topology_check`, `pre_review_check_read`, `acceptance_rollout_report_read`, and `acceptance_rollout_check`; prompt prose is not evidence. Cover current signed receipt, full 3 rounds × 2 hosts (`codex-cli` + `claude-cli`), degraded-3x1 rejection, all thresholds/membership/freshness mutations, mode-invariant diagnostics, enforce-only blocking, and non-destructive rollback history.
