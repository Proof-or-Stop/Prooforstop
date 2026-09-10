# Core two repairs: bounded acceptance

Scope: the user prioritizes heavy verification cost and actual owner/reviewer
implementation adoption. Work remains in the existing Lab; no main integration,
Story creation, live foreign-session takeover, or version upgrade is authorized.

## A. Complete identity command

- Baseline: unchanged ccbc0a1784 identity-cutover test and its existing frozen
  source witnesses, independently copied compiled runtime. The initial refactored
  baseline failed its own frozen source hash and was cancelled, not promoted.
- Candidate: same registered public operation and mutation inventory, including
  all 250 consumer/origin cases and every canonical/negative control. No added
  sparse omission, dropped case, changed timeout, or stat-only content cache.
- Optimization: reuse a full protected baseline only for ignored, untracked,
  nonsymlink injections in the private compiled runtime. Always take a complete
  after snapshot for every operation. Observable injections retain before/after.
- Native functional RED: four operations redundantly take eight full snapshots.
  GREEN requires at most five, with protected mutation counterexamples retained.
- Performance pilot: one non-overlapping baseline/candidate complete command pair
  on this host, retaining entire logs. Both must exit zero, with identical case
  identities and canonical control coverage. Candidate elapsed wall time must be
  at least 15% lower to pass this pilot. Charge preparation separately and include
  it in a second total; never sum overlapping command durations. Report order and
  shared-host confounding. This is not a Story lead-time or population estimate.
- If the pilot fails, keep the result and investigate; do not change the threshold
  or select a faster subset. No completed valid pair existed when this was written.

## B. Enrolled local implementation cohort

- Baseline RED: an actual CLI ignores a wrong/missing session manifest when no
  separate expected/required environment variables were supplied.
- Candidate: explicit capture-once manifest, required inherited pin, absolute local
  CLI shim, shared-dispatcher enforcement, and actual process witness containing
  observed digest, entrypoint, PID and argv digest (no argument plaintext).
- Positive executions: developer and independent Claude CLI both invoke actual
  commands through the same captured runtime epoch; inspect each child's witness.
- Negatives: wrong/missing/malformed/conflicting manifest, wrong direct entry,
  implementation drift, no silent capture overwrite or repinning. Existing pins
  remain valid controls. No witness is a signed Story role credential.
- This enrolls this Lab owner/reviewer. Running foreign Stories and environment-
  stripping/hostile callers are explicitly not migrated or sandboxed. We cannot
  claim repository-wide live adoption from a Lab-only execution.

Claude audits source, relevant executions, failed trials, and final calculations.
The six-direction ledger remains broader than these two bounded subclaims.

## Baseline preparation correction (before any valid complete pair)

The prior Lab ccbc0a1784 also contains six raw provider/query transcripts whose
historical terms fail the active-source identity scanner. That trial was cancelled
after recording the actual failure, without claiming a performance RED. The valid
baseline is now the requested committed main442f6f38 (0.3.296), with its unchanged
test and freshly built private runtime. The six original Lab files are preserved
byte-for-byte in historical-raw-transcripts.tar.gz; source scanner rules are not
changed. Candidate-only test/refactor and runtime-contract hashes are explicitly
updated in their two existing reviewed-witness lists and independently reviewed.
The original plan hash and failed/cancelled logs remain retained. The same-case,
both-arms-pass, 15% threshold, and one-pair limitations are unchanged.
