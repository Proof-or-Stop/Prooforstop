# B-db1b Real-Machine Transcript Diff

Generated: 2026-07-02

## Expected

- `pinn_claim_check --fixture=complete --claimId=C9 --format=json` should allow the complete C9 fixture, check all nine adapter families, and keep deployment, external completion, terminal completion, and PDE correctness claims false.
- `pinn_benchmark_run --format=json` should report a passing deterministic B1-B15 benchmark where A4 rejects all 15 injections and weaker arms expose unsafe acceptance.
- `pinn_report_render --format=text` should render the artifact index and fixed claim-boundary paragraph without claiming PDE correctness, deployment readiness, or external completion.
- Supplied report and narrative overclaim probes should be blocked instead of re-emitted or accepted.

## Actual Transcript

```text
$ node bin/lattice.js pinn_claim_check --fixture=complete --claimId=C9 --format=json
{
  "allowed": true,
  "nextAction": "advance",
  "checkedAdapters": 9,
  "deploymentReadyClaim": false,
  "externalCompletionClaim": false,
  "terminalCompletionClaim": false,
  "pdeCorrectnessClaim": false
}
```

```text
$ node bin/lattice.js pinn_benchmark_run --format=json
{
  "suiteStatus": "PASS",
  "totalInjections": 15,
  "a4Rejected": 15,
  "weakerUnsafe": true,
  "claims": {
    "deploymentReadyClaim": false,
    "externalCompletionClaim": false,
    "terminalCompletionClaim": false,
    "pdeCorrectnessClaim": false
  }
}
```

```text
$ node bin/lattice.js pinn_report_render --format=text
PINN claim-admissibility report
suiteStatus: PASS
A4 blocks: 15/15
artifactIndex:
  - injection-corpus (pinn-failure-injections) sha256:55b725533a2b36f4ecd24642b868e13b0d5e03f4a2b66d6db55da7b9a0ccdaef
  - arm-metrics (pinn-benchmark-metrics) sha256:33ec3e331660a0961afa7f03494fb2d58d40de594663b165d62b6917fd279761
  - boundary (claim-boundary) sha256:cfe1801aa6aa2a9d0b76c471d9a8944755fef3dbbc5cd1ee2f8cbeb246d7dda9
deploymentReadyClaim: false
externalCompletionClaim: false
terminalCompletionClaim: false
pdeCorrectnessClaim: false
Proof-or-Stop for PINNs is a local claim-admissibility control layer. It checks whether a stated PINN claim has current, bound evidence before advancing; it does not prove PDE correctness, deployment readiness, or external completion.
```

```text
$ node --input-type=module <direct overclaim probe>
{
  "suppliedReportOverclaimRejected": true,
  "passivePdeNarrativeBlocked": true,
  "numericDirectClaimBlocked": true
}
```

## Diff Notes

- Expected and actual match for the complete C9 path: the runtime allows only the admissibility transition and keeps all completion/correctness claim flags false.
- Expected and actual match for the benchmark: A4 rejects every B1-B15 injection, and weaker arms still expose the unsafe-acceptance gap.
- Expected and actual match for report rendering: the report includes the artifact index and fixed boundary paragraph, with no PDE/deployment/external-completion overclaim.
- Expected and actual match for adversarial probes: supplied report overclaims, passive PDE correctness narrative, and numeric direct completion claims are blocked.

Acceptance verdict: accepted.
