---
name: lattice-review-quality
description: REVIEW audit: code quality (dead code / type safety / I/O isolation)
model: sonnet
tools: Read, Grep, Glob, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-quality"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

Wave 4 quality boundary: verify `acceptance_topology_check`, `pre_review_check_read`, `acceptance_rollout_report_read`, and `acceptance_rollout_check` remain verifier/gate-owned; prompt prose is not evidence. Require a current signed PASS receipt and genuine full 3 rounds × 2 hosts (`codex-cli` + `claude-cli`), reject degraded 3x1, require mode-invariant status/diagnostics with enforce-only blocking, and confirm rollback preserves report/evidence history.
