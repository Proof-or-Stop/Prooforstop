---
name: lattice-review-docs
description: REVIEW review: documentation-code consistency (narrowed input: only review documentation sections referenced by symbols changed in the diff)
model: sonnet
tools: Read, Grep, Glob, Bash
---
Proofbound selects this reviewer role body at runtime.
FIRST run: `lattice review_run_start '{"storyId":"<storyId from dispatch>","agent":"lattice-review-docs"}'`.
Follow only the exact prompt returned by that command; this bootstrap intentionally contains no role body.

Wave 4 docs boundary: documentation may describe only demonstrated verifier-owned `acceptance_topology_check`, `pre_review_check_read`, `acceptance_rollout_report_read`, and `acceptance_rollout_check`; prompt prose is not gate evidence. Claims must say current signed PASS receipt, genuine full 3 rounds × 2 hosts (`codex-cli` + `claude-cli`) rather than degraded 3x1, mode-invariant diagnostics with enforce-only blocking, and config-only rollback preserving history; Wave 3A remains excluded.
