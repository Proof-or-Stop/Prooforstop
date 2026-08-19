# Plan: Fix post-DONE closure snapshot material projection

## CHK-001

Goal: completed stories must keep a stable historical DONE closure/status projection after later main material drift, while TEST-phase stories continue to fail stale or missing evidence before DONE.

### Red/Repro Evidence

- Repro probe: `rp-mqzkvjqx-nb3bnj`.
- Repro review: `rr-mqzkzc8e-q4mz2k`, classified as `target-bug`.
- Observed failure: `lattice done_closure {"storyId":"B-da34"}` reports `phase: DONE` but `canAttemptDone:false` with blocking stale delivery and review-escalation rows after current material changed.
- Spike: `sr-mqzkzykz-hcmwgn`, reviewed by `sr-mqzl01uz-6nz79o`, confirmed the read-only projection still consumes current material for delivery/review status.

### Implementation Steps

1. Add a focused smoke fixture that builds a DONE-shaped story, records valid completion evidence, then simulates later unrelated material drift.
2. Update read-only DONE closure projection so `phase === DONE` reports historical closure against the recorded completion snapshot instead of treating current-material drift as a blocker.
3. Align `review_escalation_status` default behavior for DONE stories with historical completion status, while preserving a visible current-material advisory/revalidation boundary.
4. Keep TEST-phase gate behavior strict: stale/missing/tampered evidence must still block before DONE.
5. Bump the CLI patch version after code behavior changes.

### Verification

- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/tasks/post-done-closure-snapshot-smoke.js` passes and covers happy, edge, and adversarial intents.
- Existing relevant smoke(s), especially review escalation/delivery freshness if touched, remain green.
- `lattice done_closure {"storyId":"B-da34"}` no longer tells the operator to redo historical DONE work solely because current material drifted.

### Non-goals

- Do not refresh or mutate B-da34 historical evidence as the fix.
- Do not weaken TEST->DONE stale evidence checks.
- Do not migrate all legacy evidence.
- Do not change unrelated active stories.
