# proof-or-stop instrument replay — M4 report

## Environment pins
- nodeVersion: v22.13.0
- platform: darwin
- instrumentCommit: 6c4e7c0a4c7aaa535526ad43170a364556f3b887

## Hypotheses
- H1 replay-determinism: **PASS** — Per scale with >=2 proof records, all records share identical canonicalJson({digests, goldMetrics}). — full: n=3 pairwiseEqual=true; small: n=30 pairwiseEqual=true
- H2 tamper-fail-closed: **PASS** — Every tamper verdict conforms to its rederivedDisposition rule (fail-closed => verifyStatus in {fail,crash} & fingerprintMatch; accepted/acknowledged-limitation => pass & fingerprintMatch; dropped => pass), every dispositionMatch===true, and the per-disposition counts equal the protocol.tamperMatrix bucket lengths. — total=27, nonConforming=0, dispositionMismatch=0, countsMatch=true
- H3 resume-integrity: **PASS** — resume-reconciliation reports dupTotal===0, gapTotal===0, and finalMultisetMatch===true. — dupTotal=0, gapTotal=0, finalMultisetMatch=true
- H4 scale-envelope: **PASS** — Every proof record elapsedMs <= protocol.budgetCaps.msPerVerify. — budgetCapMs=128217, proofCount=33, maxElapsedMs=18718, overCap=0

## Scale envelope
- full: maxElapsedMs=18718, peakEndOfRunRssBytes=976666624
- small: maxElapsedMs=2382, peakEndOfRunRssBytes=174112768

## Instrument defects
- none

## Overall: all-pass

digest: a5f07cfaa4edb99a9064efae0ed7462f1fbca76a9bef693f7ffe208eed691f05

## Claim (asserted)

> Under the recorded environment (pinned node version, platform, and instrument commit), the memory-baseline evidence instrument is replay-deterministic (identical digests over N independent replays at 1k and 1M scale), tamper-evident for the enumerated tamper matrix (every class in the fail-closed set fails closed with its pre-registered fingerprint, including classes that leave surface scores perfect), and campaign-operable (an unattended batch completed with every iteration ending in a machine-checkable proof record or an explicit stop record, surviving the probed interruption classes — process kill at an iteration boundary and mid-iteration — without duplication or gaps).
