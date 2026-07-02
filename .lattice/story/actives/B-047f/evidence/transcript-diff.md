# B-047f real-machine user-acceptance transcript + diff

Perspective: a future M6 pilot operator sets up an experiment with the three S1 tools on f4b7a21b5.

## Step 1 — freeze the protocol (M0)
EXPECTED (userSees CHK-001): freeze prints protocolHash and writes protocol.json + memory-snapshot-hash.json; validate exits 0 with PASS
ACTUAL:
  frozen: /tmp/b047f-uat-w0pM/.lattice/experiments/experience-ablation/uat-demo
  protocolHash: 616208f455fc7b91d62d026989c2a50aba39611babb71fd4c17a07e5583f78a1
  PASS protocol.json valid, protocolHash 616208f455fc7b91d62d026989c2a50aba39611babb71fd4c17a07e5583f78a1

## Step 2 — build the pair ledger (M2), reproducibility check
EXPECTED (userSees CHK-002): three files, deterministic runOrder, same-seed rebuild identical
ACTUAL:
  runOrder (6): clean-a-01::control, clean-a-01::treatment, novel-a-01::control, stale-doc-01::control, novel-a-01::treatment, stale-doc-01::treatment
  sealHash: a7e642aa404e38d96340dc6dccff4355d42891ae5088b149cef56b27fba1d7db
  PASS ledger verified: 6 arm-runs bound to protocol 616208f455fc…

## Step 3 — refusals (M0 enforcement + immutability)
EXPECTED: no-protocol root refused naming M0; post-score-record build refused; unregistered trapClass refused
ACTUAL:
  ERROR: frozen-protocol requirement not met for experiment 'uat-demo': no frozen protocol at /tmp/b047f-uat2-EMnC/.lattic
  exit=1 (expect 1) [re-captured directly: the first transcript draft piped through cut and read the pipe exit; corrected with a direct rerun]
  ERROR: manifest field '[0].trapClass' invalid: 'never-registered' is not a member of the frozen protocol's inStore group
  exit=1 (expect 1) [re-captured directly]
  ERROR: build refused: score-records.jsonl exists — the ledger is immutable once the first score record exists (plan S8
  exit=1 (expect 1) [re-captured directly]

## Step 4 — adequacy report (M5)
EXPECTED (userSees CHK-003): report states live 294/arm, seeded band max 62 at 0.625/0.25, reduction direction, paired McNemar
ACTUAL:
  adequacy report written to /tmp/b047f-uat-w0pM/adequacy: live 294/arm (paired 296 pairs), seeded band 27-62/arm (max at baseline 0.625 / MDE 0.25)
  md> In-band maximum: 62 per arm at baseline 0.625 / MDE 0.25 (grid step 0.025)
  md> Paired McNemar sizing at the band max (independence): 65 pairs (p01 0.3906, p10 0.1406)
  md> Planned N per arm: 294
  md> Paired McNemar sizing (independence): 296 pairs (p01 0.2400, p10 0.1400)
  md> (>= minControlFaultRuns control-arm fault runs; freeze at the N-maximizing

## Step 5 — selfchecks (the acceptance evidence)
ACTUAL: protocol 15/15, pair-ledger 19/19, sample-size 29/29 — all exit 0

## DIFF NOTES
All userSees expectations matched. One deliberate deviation from PLAN prose: the freeze rule is implemented as
N-maximizing-within-Wilson-CI rather than the plan letter lower-bound (review finding F-001 proved the lower bound
is not conservative; the plan S7 amendment is tracked as a follow-up chip). The md report and code comments state
the corrected rule explicitly.
