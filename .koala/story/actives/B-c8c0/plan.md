# B-c8c0 Plan

## CHK-001

**Owner**: main-agent

Repair from-draft worktree creation in the CLI path that currently sets `INIT_CHECK` without running the same bootstrap used by `story_advance`. Tighten mutable story metadata authority so checklist and review-pass writes for active linked stories fail from the main checkout with a clear worktree path instead of writing a stale mirror. Verify with a smoke task that exercises from-draft bootstrap and main-cwd rejection without touching real project metadata.

## CHK-002

**Owner**: main-agent

Wire `syncClusterResolves` into documented user entrypoints. `finding_list` should sync before rendering cluster or plain views, while `validate --story` should sync by default and retain an explicit no-sync escape hatch for diagnostics. Keep sync idempotent and warning-only for unknown cluster refs.

## CHK-003

**Owner**: main-agent

Make review pass persistence fail-fast. After `review_pass_set` writes, read back the authoritative pass list and verify the exact id persisted; duplicate or lost writes should throw. Add `review-passes.json` to DONE stray cleanup metadata whitelist so main-copy residue no longer blocks merges.

## CHK-004

**Owner**: main-agent

Normalize verification evidence through all write paths so `checklist_update` gains the same material freshness fields as `verification_evidence_add`. Preserve semantic freshness: metadata-only story churn should not stale evidence, while material source/config/test changes should still require refresh.

## CHK-005

**Owner**: main-agent

Align REVIEW routing with the retired LLM channel policy. Remove `koala-review-channel` from active reviewer opt-in while keeping `validate --channel` as the mechanical gate. Broaden channel evidence so direct successful subagent results and acceptable implementer commit authors can satisfy the execution signal without fake dispatch events.

## CHK-006

**Owner**: main-agent

Close rough workflow edges. Require explicit audit signal for PLAN add/remove scope changes so title/context freeze cannot be silently bypassed; normalize touchpoint strings before path comparison; move excluded scope from issue count to informational output; suppress repeated long-idle stale warnings with a cooldown.
