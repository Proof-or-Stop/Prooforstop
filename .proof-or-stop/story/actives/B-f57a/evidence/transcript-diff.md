# B-f57a — Real-machine acceptance transcript & diff (TEST)

Story: Tier-C M1 (crypto-deferred) — `cross_host_review` auto cross-host review collection and
finding-level disagreement surfacing.

Rhythm: PLAN outcome = expected -> run on real machine -> actual -> diff.

Scope note: M1 delivers the local capability: the command, bounded Codex reviewer leaf, host-verdict
recording, and disagreement diff. A live external two-host run against a real Codex CLI remains the
separate M3 proof-of-mechanism milestone and is deliberately outside this M1 acceptance check.

## Expected

1. `cross_host_review` is registered in the command registry.
2. It can run a read-only Codex reviewer through an authorized review-only dispatch policy.
3. It captures a structured host-B verdict bound to the orchestrator material hash and never exposes
   raw stdout as evidence.
4. It fails closed on malformed stdout, schema mismatch, materialHash mismatch, abnormal process
   exit, timeout, truncated stdout, missing/unauthorized policy, malformed policy, same-host identity,
   untrusted host-A findings input, dirty source worktree, and clean HEAD drift.
5. It records host-A and host-B verdicts as one cross-host pair and does not retain stale or partial
   verdict files if HEAD/source drift is detected at the final write boundary.
6. It combines the two verdicts into a joint decision that passes only when both hosts pass and no
   finding-level disagreement exists.

## Actual Run

Focused real-machine commands:

```text
$ npm --prefix packages/main run build
> @lattice/core@0.3.146 build
> tsc
PASS

$ node packages/main/dist/tasks/cross-host-review-smoke.js
PASS: cross_host_review smoke passed (24 checks)
```

Full story validation:

```text
$ lattice validate --story=B-f57a --json
PASS: Project validation commands passed
allPass: true
configured validate.commands: 32/32 passed
elapsed: approximately 141.2s
```

Freshness check after validation:

```text
$ lattice evidence_plan --storyId=B-f57a --json
missing: 0
rerun: 0
refreshOnly: 0
fresh: 24
```

Reviewer acceptance:

```text
concept: PASS B-f57a:RP-011
test-coverage: PASS B-f57a:RP-012
quality: PASS B-f57a:RP-013
open findings: 0
```

## Coverage Notes

The current `cross-host-review-smoke` suite covers:

- registry presence;
- structured fake Codex verdict capture;
- materialDigest binding;
- garbage stdout / missing decision / wrong materialHash fail-closed paths;
- non-zero exit, timeout, and truncated stdout fail-closed paths;
- malicious stdout injection and strict schema rejection;
- review-only dispatch policy authorization and malformed policy rejection;
- env redaction and timeout-ceiling threading;
- same-host identity rejection before spawn/record;
- malformed host-A findings rejection before spawn/record;
- dirty source worktree rejection before spawn;
- pre-hash clean HEAD drift rejection;
- post-spawn source drift rejection;
- post-spawn clean HEAD drift rejection;
- F-016 final-record post-write clean HEAD drift cleanup: the handler deletes the just-written
  host verdict pair and leaves no stale or partial verdict files for the drifted runId;
- `.lattice/`-only metadata churn control;
- disagreement diff and jointDecision behavior across pass/fail/blocked/material-divergence cases.

## Diff

Expected == actual. The only acceptance-scope change since the older transcript is additional
hardening: the suite grew from 21 to 24 checks, and `CHK-001:adversarial:6` now explicitly covers
the final verdict-record write boundary that produced F-016.

## Verdict

Accepted. M1 local cross-host review capability is delivered and verified. The independence claim
remains honestly bounded to local review lanes and structured verdict recording; cryptographic
signing / external Authority proof remains out of scope for this story.
