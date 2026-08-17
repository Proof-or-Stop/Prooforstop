# B-9e44 M0 user-acceptance transcript-diff

HEAD 724176c8e | frozen protocol contract for M1-M4

## EXPECTED (PLAN): a frozen, hash-pinned protocol.json with viability dispositions + calibration + a hermetic selfcheck.

### selfcheck (the load-bearing test)
```
selfcheck: protocol.json re-emit byte-identical (sha256 a3a781fed2814259...); 18 failClosed all carry a failure signal (fail or crash); 2 acceptanceBucket all status:pass; 6 acknowledgedLimitations all malicious+pass with a limitationNote; limitationFamily representative-not-exhaustive with 2 families (oracle-weaken + manifest-metadata-lie both represented in acknowledgedLimitations); no false-positive.
selfcheck PASS
```
### frozen protocol digest
```
protocol.json sha256: a3a781fed2814259378dae7aee80d3aa3920b5883c5d75d960509fb7901c848c
committed .sha256:     a3a781fed2814259378dae7aee80d3aa3920b5883c5d75d960509fb7901c848c
```
### tamper matrix + limitation family
```
fail-closed: 18  accepted: 2  acknowledged-limitation: 6  dropped: 1
limitationFamily: representative-not-exhaustive | oracle-weaken + manifest-metadata-lie
N: {"full":3,"small":30}  envPins.instrumentCommit: 6c4e7c0a4c7aaa535526ad43170a364556f3b887
```
### calibration
```
full-profile elapsedMs 42739 peakRssBytes 419332096 budgetCap 128217
```
## ACTUAL == EXPECTED. DIFF: none. selfcheck PASS; protocol byte-reproducible; matrix complete (18/2/6/1) with an explicit Tier-C limitation family.

## Notable outcome: the acknowledged-limitation family (6 representative classes + a general unbounded-family statement) was surfaced by a 3-round cross-vendor Codex host-2 red-team (findings F-001..F-006, all verified + resolved). It makes the instrument's real detection boundary explicit and ties it to the plan's Tier-C claim boundary.

## 5-question acceptance
1. Concrete transcript? YES (node selfcheck.mjs + protocol digest).
2. Read user output? YES (selfcheck PASS line + matrix counts).
3. Done or wonder-whats-next? DONE — protocol.json is the frozen contract M1 reads.
4. Evidence honest vs HEAD? YES (independently re-derived by 3 lanes + Codex re-check NO BLOCKING FINDINGS).
5. Verdict? ACCEPTED.
