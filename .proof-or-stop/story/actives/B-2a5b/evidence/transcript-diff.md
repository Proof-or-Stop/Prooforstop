# B-2a5b M2 user-acceptance transcript-diff

HEAD 0a45841e4 | M2 replay campaign driver + proof-or-stop ledger (H1/H4 evidence)

## EXPECTED: run-batch.mjs runs N x 2-scale generate+verify cycles into an append-only proof-or-stop batch-ledger.jsonl; H1 replay-determinism + H4 scale-envelope evidence; selfcheck exercises budget_cap/lockfile/recordless/crash paths.

### batch-ledger (H1/H4 evidence)
```
records: 33 (30 small + 3 full 1,000,000-record cycles)
unique iterationIds: 33 | missing: 0 | extra: 0 | stop: 0
H1 small n=30 PAIRWISE-EQUAL (replay-deterministic)
H1 full n=3 PAIRWISE-EQUAL (replay-deterministic)
H4: over-cap 0 max elapsed 18718ms << cap 128217ms
```
## ACTUAL == EXPECTED. DIFF: none. H1 (replay determinism) confirmed at BOTH scales incl. 3x 1,000,000-record cycles; H4 (scale envelope) all within cap; 0 recordless; every recordDigest re-derives.

## Notable: the proof-or-stop discipline was hardened over 3 cross-vendor rounds (Codex F-002/F-003 + quality F-001/F-004): every iteration ends in exactly one identity-keyed record; a generate/verify/setup/append CRASH becomes a verify_crash stop; a concurrent driver records precondition_failed to a SEPARATE blocked-ledger; and a top-level backstop guarantees the driver NEVER exits 0 with a missing/extra/dup record.

## 5-question acceptance: 1 concrete transcript YES; 2 read output YES; 3 done YES (batch-ledger.jsonl is the H1/H4 evidence M4 adjudicates); 4 evidence honest YES (3 lanes + Codex re-derived digests + reproduced crash paths); 5 ACCEPTED.
