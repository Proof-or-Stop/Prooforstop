# proof-or-stop instrument replay — M4 report

## Environment pins
- nodeVersion: v22.13.0
- platform: darwin
- instrumentCommit: 6c4e7c0a4c7aaa535526ad43170a364556f3b887

## Hypotheses
- H1 replay-determinism: **PASS** — Per scale s in protocol.N: exactly N[s] proof records exist, each with non-empty digests {records,gold,manifest} + non-empty goldMetrics, and all records share identical canonicalJson({digests, goldMetrics}). — full: n=3/3 countOk=true wellFormed=true pairwiseEqual=true pass=true; small: n=30/30 countOk=true wellFormed=true pairwiseEqual=true pass=true
- H2 tamper-fail-closed: **PASS** — The set of {class|handling} verdicts exactly equals the protocol.tamperMatrix identity set (no missing, no unexpected, no duplicate); every tamper verdict conforms to its rederivedDisposition rule (fail-closed => verifyStatus in {fail,crash} & fingerprintMatch; accepted/acknowledged-limitation => pass & fingerprintMatch; dropped => pass), every dispositionMatch===true, and the per-disposition counts equal the protocol.tamperMatrix bucket lengths. — total=27, identityMatch=true (expected=27, actual=27), nonConforming=0, dispositionMismatch=0, countsMatch=true
- H3 resume-integrity: **PASS** — resume-reconciliation carries the substantive structure (killA/killB/killC each with casualtyId+postResume+recordedBeforeKill, protocolReplaySmallCount===protocol.N.small, hypothesis===H3) AND reports dupTotal===0, gapTotal===0, finalMultisetMatch===true. — dupTotal=0, gapTotal=0, finalMultisetMatch=true
- H4 scale-envelope: **PASS** — Every proof record elapsedMs is a finite, non-negative number <= protocol.budgetCaps.msPerVerify. — budgetCapMs=128217, proofCount=33, maxElapsedMs=18718, overCap=0

## Scale envelope
- full: maxElapsedMs=18718, peakEndOfRunRssBytes=976666624
- small: maxElapsedMs=2382, peakEndOfRunRssBytes=174112768

## Instrument defects
- none

## Overall: all-pass

digest: f4224085e06db3a421bf6d6eed6204733d277696f1225403d03ab264bf3fd3ba

## Claim (asserted)

> Under the recorded environment (pinned node version, platform, and instrument commit), the memory-baseline evidence instrument is replay-deterministic (identical digests over N independent replays at 1k and 1M scale), tamper-evident for the enumerated tamper matrix (every class in the fail-closed set fails closed with its pre-registered fingerprint, including classes that leave surface scores perfect), and campaign-operable (an unattended batch completed with every iteration ending in a machine-checkable proof record or an explicit stop record, surviving the probed interruption classes — process kill at an iteration boundary and mid-iteration — without duplication or gaps).
