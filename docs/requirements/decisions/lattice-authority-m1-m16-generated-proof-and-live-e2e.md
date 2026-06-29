# Proofbound Authority M1-M16 Generated Proof And Live E2E Plan

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

## Purpose

This document proves that the Proofbound Authority M1-M16 implementation artifacts
have been generated in the Proofbound CLI worktree, and defines the dedicated live
execution run still required to prove the whole chain:

```text
queued Authority job
-> live plannedSteps execution
-> live evidence upload
-> live gate_decision receipt
-> multi-host final certification
-> fullAuthorityDone
```

Core review principles for this proof and the live run:

```text
1. don't optimize for the sake of optimization
2. don't optimize arbitrarily
3. only fix real correctness issues
4. preserve consistency of logic
```

## Scope

`M1-M16` in this document refers to the sixteen Proofbound Authority milestones in
`lattice-authority-live-integration.md`:

- M1 Contract Lock
- M2 Cross-Language Crypto Fixtures
- M3 Authority Metadata And Bootstrap
- M4 Native Receipt Verifier
- M5 Live Runner Control Plane
- M6 Authority Job Schema
- M7 Provider Executor
- M8 Evidence Upload
- M9 Repair And Stop Policy
- M10 Gate Evaluation Loop
- M11 End-To-End Authority Autopilot
- M12 Deployment And Global Verification
- M13 Proofbound Story Planner
- M14 Proofbound Job Planner
- M15 Natural-Language-To-DONE E2E
- M16 Multi-Host Final Verification

This is not a replacement for `lattice-unattended-completion-plan.md`. That
separate document describes the broader unattended completion product track.

## Status Definitions

| Status | Meaning |
| --- | --- |
| Generated complete | The milestone has concrete requirements, CLI/code surfaces, contracts, and smoke or live-test harnesses in this worktree. It is reproducible by inspecting the referenced files and running the listed commands. |
| Live E2E pending | The milestone has generated artifacts, but the final localhost run has not yet proven the whole queued job + evidence + receipt + multi-host chain against Python Proofbound Authority. |
| Live E2E complete | The final run has produced a non-skipped transcript from `http://localhost:6789/` with job id, run id, evidence refs, verified native receipt, and multi-host certification refs. |

The current proof is: **M1-M16 are generated complete**. The full live E2E chain
is still **live E2E pending** until the execution plan below is run.

## M1-M16 Generated Proof Matrix

| Milestone | Generated artifacts in this worktree | Reproducible proof commands / checks | Generated status | Boundary not overclaimed |
| --- | --- | --- | --- | --- |
| M1 Contract Lock | `docs/requirements/decisions/lattice-authority-live-integration.md`, `docs/requirements/decisions/lattice-unattended-completion-plan.md`, `docs/requirements/NAV.md`, `packages/main/src/core/command-policy.ts`, `packages/main/src/core/process-fact-levels.ts` | `rg -n "M1.*Contract Lock|Contract Lock" docs/requirements/decisions/lattice-authority-live-integration.md`; `npm --prefix packages/main run build`; `git diff --check` | Generated complete | A frozen contract is not live server evidence. |
| M2 Cross-Language Crypto Fixtures | `packages/main/src/core/lattice-authority-native.ts`, `packages/main/src/core/authority-signing.ts`, `packages/main/src/tasks/authority-runner-contracts-smoke.ts`, `packages/main/src/tasks/authority-receipt-classification-smoke.ts`, `packages/main/src/tasks/authority-live-python-stub-smoke.ts` | `npm --prefix packages/main run test:authority-runner-contracts`; `npm --prefix packages/main run test:authority-receipt-classification`; `npm --prefix packages/main run test:authority-live-python-stub` | Generated complete | Stub signing agreement does not prove a production server key. |
| M3 Authority Metadata And Bootstrap | `packages/main/src/core/authority-client.ts`, `packages/main/src/core/authority-mode.ts`, `packages/main/src/tasks/authority-live-python-smoke.ts`, `docs/requirements/decisions/lattice-authority-customer-api-key-access.md` | `npm --prefix packages/main run test:authority-client`; `npm --prefix packages/main run test:authority-live-python` with live env; `curl -s http://localhost:6789/v1/authority/policy` | Generated complete | If `test:authority-live-python` prints `SKIPPED`, M3 live proof is absent. |
| M4 Native Receipt Verifier | `packages/main/src/core/authority-receipt-classification.ts`, `packages/main/src/core/lattice-authority-native.ts`, `packages/main/src/core/authority-client.ts`, `packages/main/src/tasks/authority-completion-smoke.ts`, `packages/main/src/tasks/autopilot-authority-smoke.ts` | `npm --prefix packages/main run test:authority-completion`; `npm --prefix packages/main run test:autopilot-authority-smoke`; `lattice authority receipt verify --receiptFile=<receipt.json> --serverPublicKey=<hex> --receiptKind=gate_decision --json` | Generated complete | CLI verifies receipts; it must not mint server receipts. |
| M5 Live Runner Control Plane | `packages/main/src/core/authority-runner.ts`, `packages/main/src/core/authority-runner-live-client.ts`, `packages/main/src/core/authority-job-loop-live.ts`, `packages/main/src/tasks/authority-runner-client-smoke.ts`, `packages/main/src/tasks/authority-runner-events-smoke.ts`, `packages/main/src/tasks/authority-live-python-smoke.ts` | `npm --prefix packages/main run test:authority-runner-client`; `npm --prefix packages/main run test:authority-runner-events`; `npm --prefix packages/main run test:authority-live-python` | Generated complete | Register/heartbeat/claim/release is not enough for Authority DONE. |
| M6 Authority Job Schema | `packages/main/src/core/authority-contracts.ts`, `packages/main/src/core/authority-runner-contracts.ts`, `packages/main/src/core/planner.ts`, `packages/main/src/core/planned-steps-executor.ts` | `npm --prefix packages/main run test:authority-runner-contracts`; `npm --prefix packages/main run test:planner-unattended-smoke`; `rg -n "plannedSteps|providerPolicy|worktreePolicy|receiptPolicy" packages/main/src/core` | Generated complete | Schema validity does not prove a real queued job was executed. |
| M7 Provider Executor | `packages/main/src/providers/codex-cli.ts`, `packages/main/src/providers/claude-cli.ts`, `packages/main/src/core/planned-steps-executor.ts`, `packages/main/src/core/worktree-policy.ts`, `packages/main/src/tasks/provider-codex-smoke.ts`, `packages/main/src/tasks/provider-claude-smoke.ts`, `packages/main/src/tasks/worktree-policy-smoke.ts` | `npm --prefix packages/main run test:provider-codex-smoke`; `npm --prefix packages/main run test:provider-claude-smoke`; `npm --prefix packages/main run test:worktree-policy-smoke` | Generated complete | Provider success never equals validation success or Authority DONE. |
| M8 Evidence Upload | `packages/main/src/core/evidence-uploader.ts`, `packages/main/src/core/evidence-redaction.ts`, `packages/main/src/core/evidence-retention.ts`, `packages/main/src/core/authority-client.ts`, `packages/main/src/tasks/evidence-upload-loop-smoke.ts`, `packages/main/src/tasks/evidence-live-wiring-smoke.ts`, `packages/main/src/tasks/evidence-retention-gc-smoke.ts` | `npm --prefix packages/main run test:evidence-upload-loop-smoke`; `npm --prefix packages/main run test:evidence-live-wiring-smoke`; `npm --prefix packages/main run test:evidence-retention-gc-smoke` | Generated complete | Evidence upload does not mint receipts and does not certify DONE by itself. |
| M9 Repair And Stop Policy | `packages/main/src/core/repair-retry-loop.ts`, `packages/main/src/core/planned-steps-executor.ts`, `packages/main/src/core/budget-meter.ts`, `packages/main/src/tasks/repair-retry-loop-smoke.ts`, `packages/main/src/tasks/repair-retry-integration-smoke.ts`, `packages/main/src/tasks/budget-meter-smoke.ts` | `npm --prefix packages/main run test:repair-retry-loop-smoke`; `npm --prefix packages/main run test:repair-retry-integration-smoke`; `npm --prefix packages/main run test:budget-meter-smoke` | Generated complete | Repair can fix validation failures only; it cannot repair gate/receipt failure into DONE. |
| M10 Gate Evaluation Loop | `packages/main/src/core/authority-completion.ts`, `packages/main/src/core/authority-client.ts`, `packages/main/src/core/planned-steps-executor.ts`, `packages/main/src/tasks/authority-completion-smoke.ts`, `packages/main/src/tasks/evidence-live-wiring-smoke.ts` | `npm --prefix packages/main run test:authority-completion`; `npm --prefix packages/main run test:evidence-live-wiring-smoke`; live `POST /v1/gates/evaluate` transcript in final run | Generated complete | A stub-signed gate receipt proves verifier logic only, not production Authority DONE. |
| M11 End-To-End Authority Autopilot | `packages/main/src/core/authority-job-loop.ts`, `packages/main/src/core/authority-job-loop-live.ts`, `packages/main/src/core/autopilot-executor.ts`, `packages/main/src/core/authority-runner.ts`, `packages/main/src/tasks/authority-job-loop-smoke.ts`, `packages/main/src/tasks/authority-job-loop-live-smoke.ts`, `packages/main/src/tasks/autopilot-execute-smoke.ts` | `npm --prefix packages/main run test:authority-job-loop`; `npm --prefix packages/main run test:authority-job-loop-live-smoke`; `npm --prefix packages/main run test:autopilot-execute-smoke` | Generated complete | The final queued-job live run must still prove no dangling lease and receipt-backed terminal state. |
| M12 Deployment And Global Verification | `README.md`, `docs/guide.md`, `docs/requirements/decisions/lattice-authority-live-integration.md`, `package.json`, `packages/main/package.json`, global `lattice` command routing in `packages/main/src/cli-engine.ts` | `npm --prefix packages/main run build`; `lattice check`; `lattice autopilot status --json`; `npm --prefix packages/main run test:authority-live-python` with `http://localhost:6789/` | Generated complete | Global/local parity and server deployment are proven only by the final live transcript, not by package-local tests alone. |
| M13 Proofbound Story Planner | `packages/main/src/core/planner.ts`, `packages/main/src/handlers/planner.ts`, `packages/main/src/cli-engine.ts`, `packages/main/src/tasks/planner-unattended-smoke.ts`, `packages/main/src/tasks/natural-language-to-done-smoke.ts` | `npm --prefix packages/main run test:planner-unattended-smoke`; `npm --prefix packages/main run test:natural-language-to-done-smoke`; `lattice planner run --request="<request>" --mode=local --until=DONE --planOnly --json` | Generated complete | Planner output is not DONE until execution, evidence, and final gates pass. |
| M14 Proofbound Job Planner | `packages/main/src/core/planner.ts`, `packages/main/src/core/authority-contracts.ts`, `packages/main/src/core/planned-steps-executor.ts`, `packages/main/src/tasks/planner-unattended-smoke.ts` | `npm --prefix packages/main run test:planner-unattended-smoke`; `lattice planner run --request="<request>" --mode=authority --until=DONE --planOnly --json` | Generated complete | A generated JobPlan is not a claimed Authority job until the server queues and runner claims it. |
| M15 Natural-Language-To-DONE E2E | `packages/main/src/tasks/natural-language-to-done-smoke.ts`, `packages/main/src/tasks/planner-unattended-smoke.ts`, `packages/main/src/tasks/authority-job-loop-live-smoke.ts`, `packages/main/src/core/planner.ts`, `packages/main/src/core/authority-completion.ts` | `npm --prefix packages/main run test:natural-language-to-done-smoke`; `npm --prefix packages/main run test:planner-unattended-smoke`; live `lattice planner run --mode=authority --until=DONE --json` in final run | Generated complete | Current smoke can use a signing-correct stub; production natural-language-to-DONE requires live receipt and final certification. |
| M16 Multi-Host Final Verification | `packages/main/src/core/verdicts.ts`, `packages/main/src/handlers/verdict.ts`, `packages/main/src/core/authority-client.ts`, `packages/main/src/tasks/multi-host-authority-smoke.ts`, `packages/main/src/tasks/planner-unattended-smoke.ts` | `npm --prefix packages/main run test:multi-host-authority-smoke`; `lattice authority verdict submit --jobId=<job> --runId=<run> --receiptId=<receipt> --gateInputDigest=<digest> --json`; `lattice authority job status --jobId=<job> --receiptFile=<receipt.json> --json` | Generated complete | Host verdicts cannot replace a native gate receipt; fullAuthorityDone requires both. |

Generated-complete conclusion:

```text
M1-M16 all have generated requirement, CLI/code, and verification harness
artifacts in this worktree. The remaining proof is not generation; it is one
dedicated live E2E execution against Python Proofbound Authority.
```

## Required Live E2E Execution Plan

This plan produces the missing hard evidence for:

```text
complete queued job + live evidence + live gate receipt + multi-host final certification
```

The local server URL for this run is `http://localhost:6789/`.

### E0. Preflight: Build And Script Availability

Purpose: prove the generated CLI/test harnesses compile before any live run.

Commands:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:authority-runner-contracts
npm --prefix packages/main run test:authority-client
npm --prefix packages/main run test:authority-job-loop-live-smoke
npm --prefix packages/main run test:evidence-live-wiring-smoke
npm --prefix packages/main run test:authority-completion
npm --prefix packages/main run test:multi-host-authority-smoke
npm --prefix packages/main run test:natural-language-to-done-smoke
git diff --check
```

Pass condition:

- no TypeScript build failure;
- no smoke failure;
- no whitespace/check failure;
- every failure is classified as a real correctness issue before fixing.

### E1. Start Python Proofbound Authority On localhost:6789

Purpose: prove the server used for live evidence is the real local Python
Proofbound Authority, not a stub or alternate port.

Commands:

```bash
cd /Users/jek/Documents/Work/Lattice/cord-team

export CORD_TEAM_ENV=production
export CORD_TEAM_SERVER_HOST=127.0.0.1
export CORD_TEAM_SERVER_PORT=6789
export CORD_TEAM_EVIDENCE_POLICY_PRESET=balanced-basic
export CORD_TEAM_AUTHORITY_PRODUCTION_ENFORCE=true
export CORD_TEAM_AUTHORITY_REQUIRE_HANDSHAKE=true
export CORD_TEAM_AUTHORITY_REQUIRED_MODE=enforce
export CORD_TEAM_AUTHORITY_REQUIRE_ACTOR_KEY_BINDING=true
export CORD_TEAM_AUTHORITY_REQUIRE_RUNNER_HEARTBEAT_FOR_L2=true

uv run uvicorn cord_team.api.app:create_app \
  --factory \
  --host 127.0.0.1 \
  --port 6789

curl -s http://localhost:6789/health
curl -s http://localhost:6789/v1/authority/policy
```

Pass condition:

- health endpoint responds;
- policy endpoint returns an Ed25519 server key;
- policy response reports `evidencePolicy.preset=balanced-basic` for this bounded live control-loop proof;
- the returned public key is pinned for later receipt verification;
- server logs show real request handling.

Block condition:

- server cannot start;
- policy response has no server key;
- policy response is not the bounded `balanced-basic` live proof policy;
- server key is missing, ephemeral in an unaccepted way, or production-inert
  while the run claims production Authority DONE.

### E2. Configure Customer API Key And Actor Identity

Purpose: prove customer authorization and actor identity are distinct and both
present for mutating Authority calls.

Recommended local `.lattice/authority.md` shape:

```yaml
serverUrl: http://localhost:6789/
projectId: project-live-1
serverKeyId: <server-key-id>
serverPublicKeyEncoding: hex
serverPublicKey: <server-public-key-hex>
customerApiKeyPath: .lattice/secrets/customer-api-key
actorId: runner-live-1
actorRole: runner
actorKeyId: runner-live-1-key
actorKeyEncoding: hex
actorKeyPath: .lattice/secrets/runner-actor-key
runnerId: runner-live-1
sessionId: session-live-1
```

Runtime environment for the live smoke:

```bash
export LATTICE_AUTHORITY_LIVE_URL=http://localhost:6789/
export LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=<server-public-key-hex>
export LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=.lattice/secrets/customer-api-key
export LATTICE_AUTHORITY_ACTOR_ID=runner-live-1
export LATTICE_AUTHORITY_ACTOR_ROLE=runner
export LATTICE_AUTHORITY_ACTOR_KEY_PATH=.lattice/secrets/runner-actor-key
export LATTICE_AUTHORITY_ACTOR_KEY_ENCODING=hex
export LATTICE_AUTHORITY_RUNNER_ID=runner-live-1
export LATTICE_AUTHORITY_SESSION_ID=session-live-1
export LATTICE_AUTHORITY_PROJECT_ID=project-live-1
```

Runtime environment for actual Proofbound CLI authority mode:

```bash
export LATTICE_AUTHORITY_MODE=enforce
export LATTICE_AUTHORITY_URL=http://localhost:6789/
export LATTICE_AUTHORITY_SERVER_PUBLIC_KEY=<server-public-key-hex>
export LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING=hex
export LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=.lattice/secrets/customer-api-key
export LATTICE_AUTHORITY_ACTOR_ID=runner-live-1
export LATTICE_AUTHORITY_ACTOR_ROLE=runner
export LATTICE_AUTHORITY_ACTOR_KEY_PATH=.lattice/secrets/runner-actor-key
export LATTICE_AUTHORITY_ACTOR_KEY_ENCODING=hex
export LATTICE_AUTHORITY_RUNNER_ID=runner-live-1
export LATTICE_AUTHORITY_SESSION_ID=session-live-1
export LATTICE_AUTHORITY_PROJECT_ID=project-live-1
```

Pass condition:

- `lattice authority status --json` reports customer API key configured without
  printing the key;
- missing customer API key blocks mutating requests;
- missing actor key blocks signed runner operations;
- runner actor cannot request gate evaluation unless a separate gate-capable
  actor key is configured.

### E3. Prove Live Control Plane Is Not Skipped

Purpose: prove policy discovery and runner control plane reach the Python
server.

Command:

```bash
npm --prefix packages/main run test:authority-live-python
```

Required output:

```text
authority live Python smoke passed: policy + control-plane
```

Pass condition:

- output is not `SKIPPED`;
- policy server key matches `LATTICE_AUTHORITY_LIVE_PUBLIC_KEY`;
- runner registration, heartbeat, claim, and release are reported;
- any claimed job is released if it is not executed in this step.

### E4. Queue One Real Authority Job

Purpose: create the missing live queued job proof.

Input requirements for the queued job:

- `jobId`, `runId`, `storyId`, `projectId`;
- `mode=authority`;
- `until=DONE`;
- typed `plannedSteps[]`;
- `providerPolicy`, `worktreePolicy`, `retryPolicy`, `stopPolicy`,
  `evidencePolicy`, `receiptPolicy`, `lease`, and `multiHostPolicy`;
- at least one validation step;
- at least one evidence-producing step;
- a `gate.evaluate` step;
- multi-host policy requiring final certification for full DONE.

Preferred command path:

```bash
lattice planner run \
  --request="<small correctness-scoped change>" \
  --interactionMode=autonomous \
  --mode=authority \
  --until=DONE \
  --requireMultiHost \
  --planOnly \
  --json
```

Then queue the generated Authority job through the Python Authority job creation
or seed path. If the current Python server cannot queue a job with the required
shape, record the exact missing endpoint/field as a blocker instead of faking a
queued job.

Pass condition:

- the server stores a queued job retrievable by the runner claim endpoint;
- the job spec contains non-placeholder typed `plannedSteps[]`;
- the job is bound to the same story/checklist/planner/job digests recorded in
  the planner output;
- server-side job metadata contains no raw customer API key or private actor key.

### E5. Execute The Queued Job Through The Live Runner

Purpose: prove Stage B can consume the queued job rather than local argv
synthesis or a job-file-only fixture.

Command:

```bash
lattice autopilot execute \
  --mode=authority \
  --storyId=<story-id> \
  --until=DONE \
  --json
```

Pass condition:

- live runner registers, heartbeats, and claims exactly one queued job;
- claimed job identity matches `storyId`, `mode=authority`, and `until=DONE`;
- executor consumes server-provided `plannedSteps[]`;
- per-step evidence is uploaded to live Authority endpoints;
- server-side evidence refs are returned or queryable;
- failed validation routes into bounded repair/retry or blocks with exact reason;
- no dangling lease remains.

Block condition:

- no job claimed;
- job envelope malformed;
- job identity mismatch;
- evidence upload unavailable when required;
- gate-capable actor key missing for gate evaluation;
- receipt returned but native verification fails.

### E6. Request And Verify The Live Gate Receipt

Purpose: prove `authorityDone` comes from a native server-signed receipt.

Command shape:

```bash
lattice authority receipt verify \
  --receiptFile=<gate-decision-receipt.json> \
  --serverPublicKey="$LATTICE_AUTHORITY_SERVER_PUBLIC_KEY" \
  --serverPublicKeyEncoding=hex \
  --receiptKind=gate_decision \
  --receiptProjectId=project-live-1 \
  --receiptStoryId=<story-id> \
  --json
```

Pass condition:

- receipt kind is `gate_decision`;
- receipt verifies against the pinned server public key;
- receipt binds job id, run id, project id, story id, material hash, evidence
  refs, policy version, decision digest, and timestamp;
- executor reports `receiptVerified=true`;
- per-run `authorityDone=true` only after validation passed and receipt verified.

Boundary:

- `fullAuthorityDone` remains false until E7 final host certification passes.

### E7. Run Three Multi-Host Final Certification Waves

Purpose: prove M16 and prevent single-host or stale-anchor overclaim.

Each wave must include at least two independent hosts. Recommended hosts:

- Codex CLI reviewer
- Claude CLI reviewer
- Gemini CLI reviewer when available

Every prompt must include:

```text
don't optimize for the sake of optimization
don't optimize arbitrarily
only fix real correctness issues
preserve consistency of logic
```

`--promptDigest` must be computed from the canonical final host-check prompt
contract used by the CLI. Arbitrary or legacy prompt digests are invalid for
final host verdict submission because they do not prove that the fourth
principle, `preserve consistency of logic`, was present in the three review
waves.

Each host reviews the same anchors:

- git HEAD;
- material hash;
- job id;
- run id;
- receipt id;
- gate input digest;
- evidence refs;
- test command transcripts;
- final status JSON.

Submit server-backed verdicts:

```bash
lattice authority verdict submit \
  --jobId=<job-id> \
  --runId=<run-id> \
  --storyId=<story-id> \
  --provider=<codex|claude|gemini> \
  --role=verifier \
  --reviewWaveId=<wave-id> \
  --decision=pass \
  --materialDigest=<material-digest> \
  --validationDigest=<validation-digest> \
  --gateInputDigest=<gate-input-digest> \
  --receiptId=<receipt-id> \
  --promptProfile=lattice-final-host-check-v1 \
  --promptDigest=<prompt-digest> \
  --json
```

Check final status:

```bash
lattice authority job status \
  --jobId=<job-id> \
  --runId=<run-id> \
  --receiptFile=<gate-decision-receipt.json> \
  --requiredHosts=2 \
  --json
```

Pass condition:

- three bounded waves are recorded;
- every wave has at least two independent hosts;
- all hosts inspect the same anchors;
- any material repair invalidates prior verdicts and forces fresh receipt plus
  fresh waves;
- final status reports `receiptVerified=true`, `authorityDone=true`,
  `multiHostVerified=true`, and `fullAuthorityDone=true`.

### E8. Prove Non-Authority Mode Remains Local

Purpose: preserve the user's two-mode requirement.

Commands:

```bash
unset LATTICE_AUTHORITY_MODE
unset LATTICE_AUTHORITY_URL

lattice autopilot execute \
  --mode=local \
  --storyId=<story-id> \
  --until=TEST \
  --json

lattice planner run \
  --request="<small correctness-scoped change>" \
  --interactionMode=autonomous \
  --mode=local \
  --until=DONE \
  --requireMultiHost \
  --json
```

Pass condition:

- no request reaches `http://localhost:6789/`;
- local execution may produce local validation/evidence;
- local host certification may produce local review status;
- `authorityDone=false`;
- `receiptVerified=false`;
- `fullAuthorityDone=false`.

## Final Evidence Bundle

The live E2E run is complete only when the evidence bundle contains:

- command transcript for E0-E8;
- Python server startup command and health/policy responses;
- pinned server public key and server key id;
- customer API key source summary with secret value redacted;
- actor id, actor role, actor key id, runner id, session id, and project id;
- queued job id and run id;
- claimed lease id and terminal lease disposition;
- plannedSteps digest;
- per-step evidence refs;
- gate input digest;
- verified native gate receipt id and receipt file;
- multi-host verdict refs for three waves;
- final `authority job status` JSON;
- separate local/non-authority transcript proving zero Authority server contact.

Final claim wording must be exact:

| Final claim | Required evidence |
| --- | --- |
| `localDone` | Local execution and local validation completed under local policy. |
| `authorityDone` | Live Authority evidence plus verified native `gate_decision` receipt. |
| `fullAuthorityDone` | `authorityDone=true` plus passing multi-host final certification. |

## Fail-Closed Rules

- If `test:authority-live-python` skips, the live proof is absent.
- If no real queued job is claimed, M11 live proof is absent.
- If live evidence upload fails and evidence is required, stop blocked.
- If the gate receipt is missing, stale, tampered, wrong-project, wrong-story,
  wrong-run, or signed by an unpinned key, `authorityDone=false`.
- If fewer than three final review waves are recorded, `fullAuthorityDone=false`.
- If hosts inspect different anchors, that wave is invalid.
- If any host reports a real correctness blocker, repair only that issue, then
  rerun the affected execution milestone and all final host waves.
- If a proposed fix is only arbitrary optimization, defer it to a follow-up
  Story and do not block final DONE on it.

## Execution Ownership

Recommended host split for the live run:

| Owner | Responsibility |
| --- | --- |
| Codex coordinator | Maintain this evidence matrix, classify blockers, and reject overclaims. |
| Claude or Codex execution host | Start Python Authority, configure keys, queue the job, and run the live executor commands. |
| Codex review host | Verify transcript consistency, receipt verification, and non-authority zero-contact proof. |
| Claude review host | Independently review the same final anchors for correctness blockers. |
| Gemini review host | Optional third host when available; if unavailable, record the availability blocker and keep the two-host minimum. |

The live E2E run should not add features unless the run exposes a real
correctness issue in an existing requirement, contract, or endpoint.
