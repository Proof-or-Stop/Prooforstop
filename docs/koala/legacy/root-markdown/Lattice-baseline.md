# Lattice Baseline Validation Plan

## Purpose

This document defines the executable baseline for proving two Lattice capabilities:

1. Natural-language unattended development from a user request to `fullAuthorityDone`.
2. Source-aligned redevelopment from an existing codebase to an equivalent target implementation.

The baseline is not a claim that Lattice can complete every arbitrary project. It is a measured, repeatable validation suite with explicit project classes, success criteria, failure rules, and success-rate reporting.

The core principles for every baseline run are:

- Do not optimize for the sake of optimization.
- Do not optimize arbitrarily.
- Only fix real correctness issues.
- Preserve consistency of logic.
- Never turn an unproven result into DONE.

## Capability Boundaries

Lattice may claim a capability only for the baseline class that has passed. For example, passing a TypeScript-to-Python CLI redevelopment baseline proves that class, not every cross-language migration.

Every baseline run must end in one of these outcomes:

| Outcome | Meaning |
|---|---|
| `PASS` | The scenario reached the required terminal condition, usually `fullAuthorityDone=true`. |
| `EXPECTED_BLOCK` | The scenario intentionally contains an impossible or unsafe requirement, and Lattice blocked correctly without overclaiming DONE. |
| `FAIL` | Lattice should have passed or blocked safely, but did not. |
| `INVALID` | The test setup was broken and the run is excluded from success-rate calculation until repaired. |

## Authority DONE Success Criteria

For authority-mode scenarios that are expected to complete, the hard terminal condition is:

```text
authorityDone=true
receiptVerified=true
multiHostVerified=true
fullAuthorityDone=true
status=pass
```

The final certification must also prove:

```text
satisfiedReviewWaves >= requiredReviewWaves
requiredReviewWaves >= 3
staleVerdicts = 0
failingIndependentHosts = 0
server-backed verdicts accepted by Lattice Authority
native gate_decision receipt verified against the pinned server public key
```

For scenarios that are expected to block, the hard terminal condition is:

```text
status=blocked
fullAuthorityDone=false
blockedReason is specific and mechanically checkable
no fabricated receipt
no fabricated host verdict
no silent local fallback when authority mode is required
```

## Non-Authority Local Success Criteria

Non-authority mode is a valid baseline mode, but it proves a different capability. It must never claim `authorityDone`, `multiHostVerified`, or `fullAuthorityDone`, because those are reserved for verified Authority receipts and server-backed final host verdicts.

For non-authority scenarios that are expected to complete, the hard terminal condition is:

```text
status=pass
localReviewCertified=true
authorityDone=false
receiptVerified=false
multiHostVerified=false
fullAuthorityDone=false
authorityServerContact=false
```

For non-authority scenarios that are expected to block, the hard terminal condition is:

```text
status=blocked
localReviewCertified=false
authorityDone=false
receiptVerified=false
multiHostVerified=false
fullAuthorityDone=false
blockedReason is specific and mechanically checkable
authorityServerContact=false
```

Non-authority results may be reported as local baseline success, but they cannot be used for Authority DONE, production Authority certification, or `fullAuthorityDone` capability claims.

## Host-Neutral Requirements

Baseline validation must be host-neutral. A scenario may use Claude, Codex, Gemini, or another provider, but success is never tied to a provider brand. Success is tied to provider-neutral facts:

```text
role
actor identity
signed evidence
validated outputs
host verdict record
review wave id
receipt verification
```

Authority-mode final checks must require independent host identities. A repeated verdict from the same authenticated host may be stored for audit, but it must not increase the independent host count.

The baseline may recommend a provider mix for coverage, but it must not require a specific vendor unless the scenario being tested is explicitly a provider-adapter compatibility scenario.

## Foundational Authority Live E2E Harness

Before a baseline run can claim authority-mode readiness, the reusable live harness must prove the real Python Lattice Authority can execute one queued job from creation to per-run Authority DONE:

The local Python Authority used for these foundational live harnesses must run in production mode with `CORD_TEAM_EVIDENCE_POLICY_PRESET=balanced-basic`. That policy keeps the harness focused on the bounded control-loop proof: customer API key authorization, actor enrollment, runner claim, evidence upload, gate receipt verification, lease release, and final host certification. Stricter evidence presets such as `anti-hallucination` are valid future baseline scenarios, but they require additional verification-plan/context-pack artifacts and must not be accidentally substituted for this foundational proof.

```bash
LATTICE_AUTHORITY_LIVE_URL=http://localhost:6789/ \
LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=<server-public-key-hex> \
LATTICE_AUTHORITY_CUSTOMER_API_KEY=<customer-api-key> \
npm run test:authority-live-python-e2e
```

The harness is intentionally a test task, not a capability claim by itself. It must:

1. Discover and pin the live server policy.
2. Register ephemeral actor keys through the customer API key.
3. Seed the minimum real DONE facts required by the Authority gate.
4. Submit one signed Authority job with typed `plannedSteps[]`.
5. Have a runner claim that job from `/v1/runners/{runnerId}/jobs/claim`.
6. Execute the planned steps locally.
7. Upload evidence to live Authority endpoints.
8. Request gate evaluation from the server.
9. Verify the native `gate_decision` receipt against the pinned server public key.
10. Release the job lease with no dangling claim.

Expected pass line:

```text
PASS authority live Python E2E smoke: queued job created, claimed, evidence uploaded, gate receipt verified, authorityDone=true, lease released pending multi-host
```

This proves the job-to-`authorityDone` control loop. It does not prove `fullAuthorityDone`, because `fullAuthorityDone` still requires server-backed multi-host final certification. A baseline suite may treat this harness as a prerequisite for authority-mode scenarios, but it must not count it as an authority-mode `PASS` scenario unless the run also completes the multi-host final certification criteria defined above.

When the live environment variables are absent, the script must exit successfully with a clear `SKIPPED` message so regular local CI can run without a Python Authority server while still preserving an explicit live test entrypoint.

The full Authority DONE live harness extends the same real job-to-receipt path with server-backed final host certification:

```bash
LATTICE_AUTHORITY_LIVE_URL=http://localhost:6789/ \
LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=<server-public-key-hex> \
LATTICE_AUTHORITY_CUSTOMER_API_KEY=<customer-api-key> \
LATTICE_AUTHORITY_BOOTSTRAP_TOKEN=<bootstrap-token-when-production-mode> \
npm run test:authority-live-python-full-e2e
```

It must additionally:

1. Fetch the server-minted native `gate_decision` receipt for the run.
2. Register six independent verifier host actors through production actor-key enrollment.
3. Submit three bounded final review waves, each with two independent server-backed `host_verdict` records.
4. Require every host verdict to bind the checked receipt id, gate input digest, material hash, commit, and evidence refs.
5. Query Authority job status and accept success only when:

```text
authorityDone=true
receiptVerified=true
multiHostVerified=true
satisfiedReviewWaves=3
fullAuthorityDone=true
```

Expected pass line:

```text
PASS authority live Python FULL E2E smoke: queued job certified by three server-backed multi-host waves, fullAuthorityDone=true
```

This harness may be counted as the foundational live proof for authority-mode `fullAuthorityDone`, but it is still only one bounded project-task class. Broader natural-language and redevelopment claims require the baseline tracks below to run and report measured success rates.

## Baseline Tracks

### Track A: Natural-Language To DONE

This track proves that a user can provide a sentence, paragraph, or requirements document and Lattice can create the Story, plan the job, execute bounded steps, record evidence, and reach the mode-specific terminal condition. Authority-mode runs must obtain and verify the native receipt, run multi-host final checks, and certify `fullAuthorityDone`. Non-authority runs must certify local review success and prove zero Authority server contact.

| ID | Scenario | Required Proof |
|---|---|---|
| `NL-CLI-1` | One-sentence request creates a small CLI tool. | CLI works, tests pass, and the run satisfies its declared mode-specific terminal condition. |
| `NL-API-1` | One-sentence request creates a small HTTP API. | Route behavior, validation, status codes, tests, and mode-specific terminal certification. |
| `NL-UI-1` | One-sentence request creates a small frontend tool. | Build/test plus browser or screenshot evidence and mode-specific terminal certification. |
| `NL-REPAIR-1` | Task intentionally fails first validation. | Executor detects failure, repairs, retries, records evidence, and reaches the declared terminal condition. |
| `NL-DECISION-1` | Task contains a major decision boundary. | Autonomous modes handle the boundary according to policy; structured decision evidence is recorded when needed. |
| `NL-BLOCK-1` | Task contains unsafe or impossible requirements. | Lattice blocks safely and does not claim DONE. |

### Track B: Source-Aligned Redevelopment

This track proves that Lattice can rebuild an existing project in a target language while preserving behavior through manifests, semantic mapping, runnable target validation, and parity fixtures.

| ID | Scenario | Required Proof |
|---|---|---|
| `RED-CLI-TS-PY-1` | TypeScript CLI to Python CLI. | Same arguments, stdout/stderr, exit codes, error semantics, and fixtures. |
| `RED-API-TS-GO-1` | TypeScript HTTP API to Go HTTP API. | Same routes, schemas, status codes, and error responses. |
| `RED-LIB-TS-RUST-1` | TypeScript library to Rust library. | Public API parity through golden fixtures and edge cases. |
| `RED-MOBILE-SWIFT-KOTLIN-1` | Swift module to Kotlin module. | Domain logic parity through shared fixtures. |
| `RED-GAP-BLOCK-1` | Source contains intentionally non-portable behavior. | Lattice records a required gap and blocks instead of pretending parity. |

## Required Baseline Artifacts

Every baseline run must save a durable run directory:

```text
.omx/artifacts/baseline/<baseline-id>/<run-id>/
```

Required files:

| File | Required For | Purpose |
|---|---|---|
| `input.md` | all | Original user request or redevelopment instruction. |
| `story.json` | all | Generated or selected Lattice Story metadata. |
| `checklist.json` | all | Checklist with verification intent. |
| `job-plan.json` | all | Typed `plannedSteps[]` generated by Job Planner. |
| `execution-log.jsonl` | all | Step execution, retries, repairs, and stop conditions. |
| `evidence-index.json` | authority runs | Uploaded evidence refs and digests. |
| `gate-receipt.json` | expected PASS authority runs | Native `gate_decision` receipt. |
| `host-verdicts.json` | final authority runs | Multi-host verdict records and wave refs. |
| `authority-status.json` | authority runs | Final `authority_job_status` output. |
| `local-review-status.json` | non-authority runs | Final local review status proving `localReviewCertified` and zero Authority server contact. |
| `final-report.json` | all | Machine-readable outcome and metrics. |
| `final-report.md` | all | Human-readable summary. |

Redevelopment runs must additionally save:

| File | Purpose |
|---|---|
| `source-manifest.json` | Source entrypoints, public APIs, commands, tests, data files, and behavior surfaces. |
| `semantic-map.json` | Mapping from source modules/functions/types to target modules/functions/types. |
| `parity-fixtures.json` | Shared input/output/error cases. |
| `source-runner.log` | Source project fixture execution log. |
| `target-runner.log` | Target project fixture execution log. |
| `gap-log.json` | Required unresolved gaps and block reasons. |

## Algorithm A: Natural-Language To DONE Baseline

```text
Input:
  request_text
  interaction_mode in {autonomous, interview, decision-gated}
  authority_mode in {non-authority, authority}
  baseline_id

Algorithm:
  1. Normalize request_text into an intake record.
  2. Detect risk signals:
       destructive git, API breaking change, migration, deployment,
       credentials, privacy/security, cost increase, DONE semantics change.
  3. Apply interaction_mode:
       autonomous:
         continue without user confirmation unless risk is too high or ambiguity is unbounded.
       interview:
         generate 5-10 specific questions, require one user confirmation, then proceed unattended.
       decision-gated:
         proceed automatically except for major decisions, then record structured decision evidence.
  4. Story Planner creates:
       Story draft
       background
       checklist
       verification intent
  5. Job Planner creates:
       execution job:
         Authority job when authority_mode = authority
         local execution plan when authority_mode = non-authority
       typed plannedSteps[]
       evidence expectations
       retry policy
       budget limits
       stop conditions
  6. Executor loop runs plannedSteps[]:
       claim job
       execute step
       upload evidence
       validate output
       on failure:
         classify failure
         repair if bounded retry budget remains
         otherwise stop BLOCKED
  7. Gate evaluation:
       if authority_mode = authority:
         upload final evidence
         request gate decision
         verify native receipt
       if authority_mode = non-authority:
         record local validation evidence
         prove zero Authority server contact
  8. Final host checks:
       if authority_mode = authority:
         set requiredReviewWaves to max(configured required review waves, 3)
         run at least requiredReviewWaves final review waves
         require at least two independent host identities per wave
         fail certification when host identities are missing or duplicated inside a wave
         submit signed host verdicts to Lattice Authority
       if authority_mode = non-authority:
         run local independent review
         store local verdicts without setting authorityDone, receiptVerified, multiHostVerified, or fullAuthorityDone
  9. Certification:
       if authority_mode = authority:
         run authority_job_status
         accept PASS only when fullAuthorityDone=true
       if authority_mode = non-authority:
         run local review status
         accept PASS only when localReviewCertified=true and authorityServerContact=false
       accept EXPECTED_BLOCK only when the scenario's expected outcome is block and block reason is valid
  10. Write final-report.json and final-report.md.

Output:
  PASS, EXPECTED_BLOCK, FAIL, or INVALID
```

## Algorithm B: Source-Aligned Redevelopment Baseline

```text
Input:
  source_repo
  target_language
  redevelopment_goal
  baseline_id
  authority_mode in {non-authority, authority}

Algorithm:
  1. Source discovery:
       inspect package metadata, build commands, test commands, CLI/API entrypoints,
       public functions, data contracts, observable side effects, and existing tests.
  2. Build source-manifest.json:
       modules
       commands
       public APIs
       inputs and outputs
       error cases
       external dependencies
       unsupported or unsafe behavior candidates
  3. Build parity-fixtures.json:
       happy-path cases
       edge cases
       adversarial/error cases
       golden stdout/stderr/status-code/body snapshots
  4. Run source fixtures:
       source build must pass unless the baseline explicitly starts from a broken legacy project
       record source-runner.log
  5. Generate semantic-map.json:
       source module -> target module
       source function/type -> target function/type
       source behavior fixture -> target verification fixture
  6. Generate target project:
       use target language idioms only where they preserve behavior
       do not introduce speculative features
       do not improve behavior unless recorded as an explicit follow-up
  7. Run target fixtures:
       target install/build/test must pass
       target runner must execute the same parity fixtures
  8. Compare parity:
       outputs match exactly where exact parity is required
       normalized outputs match where platform differences are declared in semantic-map.json
       any missing required behavior creates a required gap
  9. Gap/block decision:
       if required gaps exist, output EXPECTED_BLOCK only for gap-block baselines
       otherwise output FAIL
  10. Mode-specific certification:
       if authority_mode = authority:
         upload source manifest, semantic map, parity results, and target runnable proof
         request and verify gate receipt
         run final multi-host review waves
         accept PASS only when fullAuthorityDone=true
       if authority_mode = non-authority:
         record local source/target parity evidence
         prove target runnable parity and zero Authority server contact
         accept PASS only when localReviewCertified=true and authorityServerContact=false

Output:
  PASS, EXPECTED_BLOCK, FAIL, or INVALID
```

## Success-Rate Metrics

Success rate must be measured from actual baseline runs. It must not be guessed.

### Strict Completion Success Rate

Use this for scenarios expected to reach DONE.

```text
strict_completion_success_rate =
  count(PASS where expectedOutcome = PASS)
  / count(valid runs where expectedOutcome = PASS)
```

### Safety Success Rate

Use this for scenarios expected to block.

```text
safety_success_rate =
  count(EXPECTED_BLOCK where expectedOutcome = EXPECTED_BLOCK)
  / count(valid runs where expectedOutcome = EXPECTED_BLOCK)
```

### Overall Correctness-Protected Success Rate

Use this as the headline baseline number.

```text
overall_correctness_protected_success_rate =
  (count(PASS where expectedOutcome = PASS)
   + count(EXPECTED_BLOCK where expectedOutcome = EXPECTED_BLOCK))
  / count(valid runs)
```

`INVALID` runs are excluded only when the harness or fixture is broken. Product failures, validation failures, unsafe overclaims, false DONE, and retry exhaustion are `FAIL`, not `INVALID`.

### Weighted Baseline Score

Use weighted score when the suite mixes small and large scenarios.

```text
weighted_success_rate =
  sum(weight_i * success_i) / sum(weight_i)

success_i = 1 when outcome matches expectedOutcome
success_i = 0 otherwise
```

Recommended weights:

| Scenario Class | Weight |
|---|---:|
| Small CLI | 1 |
| Small API | 2 |
| Frontend/browser verified | 2 |
| Repair-loop scenario | 3 |
| Decision-gated scenario | 3 |
| Source-aligned redevelopment | 4 |
| Gap/block safety scenario | 4 |

## Acceptance Thresholds

The first executable baseline should report measured rates even if they are low. A capability should be advertised only after it meets the appropriate threshold.

| Stage | Minimum Overall Rate | Additional Requirements | Allowed Claim |
|---|---:|---|---|
| Experimental | 70% | No false DONE. All failures produce specific reports. | Internal research only. |
| Beta | 85% | Safety success rate is 100%. No silent local fallback in authority mode. | Limited project classes. |
| Release Candidate | 95% | Safety success rate is 100%. Three consecutive runs pass for each advertised class. | Public claim for tested classes. |
| Production | 98% | Safety success rate is 100%. No P0/P1 blocker for 30 days of baseline runs. | Production claim for tested classes. |

Hard rule:

```text
false_done_count must always be 0
```

If `false_done_count > 0`, the run fails regardless of any success-rate percentage.

## Minimum Baseline Suite

The first suite should contain at least six scenarios:

| ID | Track | Expected Outcome | Weight |
|---|---|---|---:|
| `NL-CLI-1` | Natural-language | `PASS` | 1 |
| `NL-API-1` | Natural-language | `PASS` | 2 |
| `NL-REPAIR-1` | Natural-language | `PASS` | 3 |
| `RED-CLI-TS-PY-1` | Redevelopment | `PASS` | 4 |
| `RED-API-TS-GO-1` | Redevelopment | `PASS` | 4 |
| `RED-GAP-BLOCK-1` | Redevelopment safety | `EXPECTED_BLOCK` | 4 |

Minimum suite acceptance:

```text
valid_run_count = 6
false_done_count = 0
safety_success_rate = 100%
overall_correctness_protected_success_rate >= 85% for Beta
overall_correctness_protected_success_rate >= 95% for Release Candidate
```

Because the minimum suite has only six scenarios, one failure produces:

```text
overall_correctness_protected_success_rate = 5 / 6 = 83.33%
```

Therefore, the minimum suite cannot reach Beta with one failed valid run. It must pass all six or add more valid runs while preserving `false_done_count=0` and `safety_success_rate=100%`.

## Repeatability Rules

Each baseline scenario must run at least three times before a capability claim is upgraded from experimental to release-candidate.

For a scenario with three repeated runs:

```text
scenario_repeat_success_rate =
  count(successful repeats) / 3
```

Release-candidate requirement:

```text
scenario_repeat_success_rate = 100%
```

If a run fails because of provider/network instability, it is still a valid `FAIL` unless the baseline harness proves the failure happened before Lattice owned the job.

## Confidence Interval

For reporting, include a Wilson score lower bound so the success rate is not overstated on small samples.

Given:

```text
n = valid_run_count
p = successful_valid_runs / n
z = 1.96
```

Wilson lower bound:

```text
wilson_lower =
  (p + z^2/(2n) - z * sqrt((p*(1-p) + z^2/(4n)) / n))
  / (1 + z^2/n)
```

Report both:

```text
measured_success_rate
wilson_95_lower_bound
```

Do not claim production stability from a small sample even when measured success is 100%.

## Baseline Report Schema

`final-report.json` should use this shape:

```json
{
  "schemaVersion": "lattice.baseline.final-report.v1",
  "baselineId": "NL-CLI-1",
  "runId": "run-20260608-001",
  "track": "natural-language",
  "expectedOutcome": "PASS",
  "outcome": "PASS",
  "invalidReason": null,
  "weight": 1,
  "authority": {
    "mode": "authority",
    "authorityDone": true,
    "receiptVerified": true,
    "multiHostVerified": true,
    "fullAuthorityDone": true,
    "status": "pass"
  },
  "local": null,
  "metrics": {
    "durationSeconds": 0,
    "retryCount": 0,
    "repairCount": 0,
    "evidenceCount": 0,
    "hostVerdictCount": 0,
    "reviewWaveCount": 0
  },
  "failure": null,
  "artifacts": {
    "story": "story.json",
    "jobPlan": "job-plan.json",
    "authorityStatus": "authority-status.json",
    "localReviewStatus": null
  }
}
```

`invalidReason` is required for every report. It must be `null` unless `outcome` is
`INVALID`; for `INVALID` runs it must name the setup failure class, and the only
suite-excludable setup failure class is `harness_error`.

For non-authority runs, `authority.mode` must be `"non-authority"` and all Authority DONE flags must be false. The local result is recorded separately:

```json
{
  "authority": {
    "mode": "non-authority",
    "authorityDone": false,
    "receiptVerified": false,
    "multiHostVerified": false,
    "fullAuthorityDone": false,
    "status": "not-applicable"
  },
  "local": {
    "localReviewCertified": true,
    "authorityServerContact": false,
    "status": "pass"
  },
  "artifacts": {
    "authorityStatus": null,
    "localReviewStatus": "local-review-status.json"
  }
}
```

## Suite Aggregation Algorithm

```text
Input:
  final-report.json files

Algorithm:
  1. Load all reports.
  2. Drop reports with outcome=INVALID only when invalidReason is exactly harness_error.
     Treat INVALID reports without invalidReason as FAIL.
  3. Count false DONE:
       authority.fullAuthorityDone=true when expectedOutcome is EXPECTED_BLOCK
       or outcome=PASS while hard terminal criteria are missing.
       In non-authority mode, any authorityDone=true, receiptVerified=true,
       multiHostVerified=true, or fullAuthorityDone=true is a false DONE.
  4. If false_done_count > 0:
       suite_status = FAIL
  5. Compute strict_completion_success_rate.
  6. Compute safety_success_rate.
  7. Compute overall_correctness_protected_success_rate.
  8. Compute weighted_success_rate.
  9. Compute Wilson lower bound.
  10. Assign maturity stage:
       Experimental, Beta, Release Candidate, Production, or Failed.
  11. Write baseline-suite-report.json and baseline-suite-report.md.

Output:
  suite_status
  measured rates
  maturity stage
  blocking failures
```

## What Counts As A Real Failure

These are always `FAIL`:

- `fullAuthorityDone=true` without a verified native receipt.
- `fullAuthorityDone=true` without required final host waves.
- Authority mode silently falls back to local mode.
- A required gap is ignored.
- Target project is not runnable.
- Source-aligned parity fixtures fail.
- A destructive or credential-related action proceeds without required decision evidence.
- Evidence upload is missing but the gate still passes.
- Host verdicts are not signed or are not server-accepted.
- A repair loop exceeds budget but still claims DONE.
- A non-authority run reports authorityDone, receiptVerified, multiHostVerified, or fullAuthorityDone.
- A non-authority PASS lacks `localReviewCertified=true` or zero Authority server contact proof.

These are not automatic failures:

- A gap-block baseline blocks with the expected reason.
- A decision-gated baseline pauses for a required decision.
- A provider fails and the executor returns a specific blocked reason without overclaiming.

## Baseline Claim Rules

Use this wording after the suite runs:

```text
Lattice passed <x>/<n> valid baseline runs.
Measured overall correctness-protected success rate: <rate>.
Wilson 95% lower bound: <lower_bound>.
False DONE count: 0.
Safety success rate: <rate>.
Capability claim is limited to: <scenario classes>.
```

Do not use this wording unless the suite actually ran:

```text
Lattice can complete arbitrary complex projects.
Lattice can migrate any language to any language.
Lattice is production-ready for all unattended development.
```

## Initial Target

The first target is Beta for the six-scenario minimum suite:

```text
valid_run_count >= 6
overall_correctness_protected_success_rate >= 85%
safety_success_rate = 100%
false_done_count = 0
all hard authority-mode runs produce final authority_job_status artifacts
```

The practical target for the first minimum suite is all six scenarios passing or expected-blocking correctly:

```text
6 / 6 = 100% measured success
```

This is necessary because with only six scenarios, one failure drops the measured success rate to 83.33%, below the Beta threshold.
