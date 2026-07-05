# B-bae9 M1 user-acceptance transcript-diff

HEAD 39a6b186a | M1 tamper-matrix conformance harness (H2 evidence)

## EXPECTED (PLAN): tamper.mjs reads the frozen protocol, asserts each class conforms to its frozen fingerprint, emits tamper-verdicts.jsonl; selfcheck proves determinism + un-gameable conformance.

### tamper.mjs (H2 conformance)
```
verdicts: 27 lines (18 failClosed / 2 acceptanceBucket / 6 acknowledgedLimitations / 1 dropped)
unique iterationIds: 27 | fingerprintMatch:false: 0 | dispositionMatch:false: 0 | failClosed-with-pass: 0
H2 conformance: PASS (mismatches=0) [confirmed by 3 reviewer lanes + Codex host-2]
```
### op-coverage self-test
```
optselftest PASS: compareFingerprint ops ==,<,>,!= + unknown-op-throw all verified
```
## ACTUAL == EXPECTED. DIFF: none. Every frozen class conforms; 0 mismatches; the harness fails loudly on a no-op mutation, dropped-drift, disposition mismatch, fingerprint mismatch, or unknown predicate op.

## Notable: the conformance harness was hardened by a cross-vendor review (Codex host-2 F-001/F-002 + quality F-004/F-005): it now asserts each mutation genuinely applied (byteDiff vs clean), re-derives the M0 disposition and checks it against the frozen bucket, enforces dropped-semantics, and unit-tests all fingerprint-predicate ops.

## 5-question acceptance
1. Concrete transcript? YES. 2. Read user output? YES (conformance PASS + op-selftest). 3. Done? YES — tamper-verdicts.jsonl is the H2 evidence M4 will adjudicate. 4. Evidence honest? YES (3 lanes + Codex independently re-ran + reproduced blind spots). 5. Verdict? ACCEPTED.
