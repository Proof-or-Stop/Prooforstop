# Proofbound Authority Remote Evidence Bundle

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

Date: 2026-06-09

Validation target: `https://staging.hostneutral.net/`

User-confirmed key/profile status: the staging Authority server key/profile is the
formal server key/profile for this validation run.

Core review rules:

- Do not optimize for the sake of optimization.
- Do not optimize arbitrarily.
- Only fix real correctness issues.
- Preserve consistency of logic.

## Claim

This bundle records the evidence required for the remote Authority validation
run that proves:

| Claim | Result | Evidence anchor |
| --- | --- | --- |
| Proofbound non-authority CLI | PASS | Local certification smoke proves zero Authority contact and no false Authority DONE flags. |
| Remote `authorityDone` | PASS | Remote queued job was created, claimed, executed, uploaded evidence, and verified a native server receipt. |
| Remote `fullAuthorityDone` | PASS | Remote queued job passed three server-backed multi-host final review waves. |

The customer API key was supplied as an `Authorization: Bearer ...` header for
remote mutating calls. The key value is intentionally redacted in this bundle
and must not be written to repository files, logs, receipts, or evidence
artifacts.

## Server Pin

| Field | Value |
| --- | --- |
| Authority URL | `https://staging.hostneutral.net/` |
| Health service | `lattice-authority` |
| Server key id | `dev-server-key` |
| Server public key fingerprint / pin | `5784b3e7f2ae3ed6e93760c00c1b1285495834d2f801ae6553490ea73276ae68` |
| Command catalog digest | `e3a6f3f3d2c6493d2d6d993b5931b7864f7887d901b58a4e8e82b1ef2f17e258` |
| Evidence schema digest | `09f4f255c5a7b0a95b423f802068f7d6100f659abf88201fed034432f353593f` |

Policy endpoint:

```text
GET https://staging.hostneutral.net/v1/authority/policy
```

Observed strong evidence policy:

| Requirement | Observed value |
| --- | --- |
| Preset | `anti-hallucination` |
| Required L2 verifier count | `2` |
| Required distinct L2 provider count | `2` |
| Require L2 run bindings | `true` |
| Require L2 command and transcript | `true` |
| Require verification plan | `true` |
| Require verification context pack | `true` |
| Require structured L2 claims | `true` |
| Require coverage bindings | `true` |
| Require negative control binding | `true` |
| Require oracle spec | `true` |
| Require test adequacy report | `true` |
| Minimum fact assurance score | `85` |

## Test Commands And Results

Local build and Authority contract matrix:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:authority-client
npm --prefix packages/main run test:authority-live-python-stub
npm --prefix packages/main run test:autopilot-execute-smoke
npm --prefix packages/main run test:authority-job-loop
npm --prefix packages/main run test:authority-enforce-matrix
```

Result:

```text
tsc PASS
authority client smoke passed
authority live python stub smoke passed
autopilot execute smoke passed
authority job-loop smoke passed
authority enforce matrix smoke passed: local/off PASS; shadow warning PASS; enforce fake-server receipt PASS; enforce no-server runner fail-closed PASS; parallel_report productionDone=false PASS
```

Non-authority local certification:

```bash
npm --prefix packages/main run test:baseline-local-certification-smoke
```

Result:

```text
baseline local certification smoke passed: non-authority local review evidence required, zero Authority contact, false-DONE negatives pinned
```

Remote `authorityDone` E2E:

```bash
LATTICE_AUTHORITY_LIVE_URL='https://staging.hostneutral.net/' \
LATTICE_AUTHORITY_LIVE_PUBLIC_KEY='5784b3e7f2ae3ed6e93760c00c1b1285495834d2f801ae6553490ea73276ae68' \
LATTICE_AUTHORITY_CUSTOMER_API_KEY='<redacted live bearer key>' \
LATTICE_AUTHORITY_PROJECT_ID='lattice-remote-evidence-bundle-20260609' \
npm --prefix packages/main run test:authority-live-python-e2e
```

Result:

```text
PASS authority live Python E2E smoke: queued job created, claimed, evidence uploaded, gate receipt verified, authorityDone=true, lease released pending multi-host
```

Remote `fullAuthorityDone` E2E:

```bash
LATTICE_AUTHORITY_LIVE_URL='https://staging.hostneutral.net/' \
LATTICE_AUTHORITY_LIVE_PUBLIC_KEY='5784b3e7f2ae3ed6e93760c00c1b1285495834d2f801ae6553490ea73276ae68' \
LATTICE_AUTHORITY_CUSTOMER_API_KEY='<redacted live bearer key>' \
LATTICE_AUTHORITY_PROJECT_ID='lattice-remote-evidence-bundle-20260609' \
npm --prefix packages/main run test:authority-live-python-full-e2e
```

Result:

```text
PASS authority live Python FULL E2E smoke: queued job certified by three server-backed multi-host waves, fullAuthorityDone=true
```

## Remote Project Records

Fixed project id:

```text
lattice-remote-evidence-bundle-20260609
```

Record query:

```text
GET https://staging.hostneutral.net/v1/projects/lattice-remote-evidence-bundle-20260609/records?limit=200
```

Observed record counts:

| Kind | Count |
| --- | ---: |
| `host_verdict` | 6 |
| `gate_decision` | 4 |
| `evidence` | 6 |
| `check` | 2 |
| `review_pass` | 2 |
| `review_run` | 2 |
| Total | 22 |

The remote `fullAuthorityDone` story:

| Field | Value |
| --- | --- |
| Story id | `B-live-full-e2e-mq6wf75i` |
| Job id | `job_d2f2bea83f2e460689a9ffbef6902ccd` |
| Run id | `session-live-full-e2e-mq6wf75i` |
| Material hash | `material-live-full-e2e-mq6wf75i` |
| Commit anchor | `head-live-full-e2e-mq6wf75i` |
| Gate input digest | `6d051caf1a43d132a5ef3c72f2c338b71f92829e0a2b6dc5d20d686cc62ca47a` |
| Checked evidence refs | `step-resolve-story:evidence`, `step-provider:evidence`, `step-validate:evidence`, `step-gate:evidence`, `step-summary:evidence` |

## Receipts

Gate receipt used by the final host verdicts:

| Field | Value |
| --- | --- |
| Receipt id | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |
| Kind | `gate_decision` |
| Input digest | `6d051caf1a43d132a5ef3c72f2c338b71f92829e0a2b6dc5d20d686cc62ca47a` |
| Decision digest | `a7a354c05270a3a012e9ad6d5672aafbb489393c04cf9cd61a9f50c07807544a` |
| Server key id | `dev-server-key` |
| Issued at | `2026-06-09T17:13:35.102203Z` |
| Server signature present | `true` |

Earlier gate receipt in the same full E2E story:

| Receipt id | Kind | Input digest | Decision digest | Server key id | Issued at | Server signature |
| --- | --- | --- | --- | --- | --- | --- |
| `5ad678c0-c361-4217-b473-548af0ba5d54` | `gate_decision` | `5819a7ab68b54c73f03994794b3659603c5e68102d3c830813b53c43d2122ed5` | `07b6e83130a78720c1dd1b239a65432545c1bdb4cac84438f31e0e0a85046ec6` | `dev-server-key` | `2026-06-09T17:13:25.872142Z` | `true` |

Host verdict receipts:

| Wave | Provider | Model | Verdict | Findings | Receipt id | Checked gate receipt |
| --- | --- | --- | --- | ---: | --- | --- |
| `wave-1` | `codex` | `codex-cli` | `pass` | 0 | `f8a36ddd-2df5-48bc-9655-fc9f9d0be810` | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |
| `wave-1` | `claude` | `claude-cli` | `pass` | 0 | `4db4f3e6-87dd-40ce-9347-e6ac295e901c` | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |
| `wave-2` | `codex` | `codex-cli` | `pass` | 0 | `17a628dd-cdcd-4491-b0cf-97f9ba95ac42` | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |
| `wave-2` | `gemini` | `gemini-cli` | `pass` | 0 | `b90620ea-f170-49f4-85aa-1a647c9059e5` | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |
| `wave-3` | `claude` | `claude-cli` | `pass` | 0 | `1cb10fb9-0828-4fa9-a664-e0951ce3bb42` | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |
| `wave-3` | `gemini` | `gemini-cli` | `pass` | 0 | `6fd6aedb-297e-4a0d-988b-accb2c217ed9` | `0a34b93d-63da-4d43-9adc-e2260d4cb59a` |

Every receipt above was fetched from:

```text
GET https://staging.hostneutral.net/v1/receipts/{receiptId}
```

Each returned `status=200`, `serverKeyId=dev-server-key`, and
`hasServerSignature=true`.

## Host Verdict Reconciliation

Verdict query:

```text
GET https://staging.hostneutral.net/v1/jobs/job_d2f2bea83f2e460689a9ffbef6902ccd/verdicts
```

Server reconciliation:

| Field | Value |
| --- | --- |
| Total verdict count | `6` |
| Independent host verdict count | `6` |
| Passing independent host count | `6` |
| Required independent host count | `2` |
| Multi-host gate satisfied | `true` |
| Has failing verdict | `false` |
| Failing host ids | `[]` |
| Failing findings | `[]` |

Satisfied review waves:

| Review wave | Independent providers |
| --- | --- |
| `wave-1` | `codex`, `claude` |
| `wave-2` | `codex`, `gemini` |
| `wave-3` | `claude`, `gemini` |

## Implementation Snapshot

The remote run validated the current worktree after the Authority integration
fixes for:

- remote strong evidence policy compatibility;
- L2 evidence producer/verifier run bindings;
- distinct provider and command-class coverage;
- server-supported provider policy projection;
- Python-style receipt input digest verification;
- native `gate_decision` receipt verification before `authorityDone`;
- three-wave server-backed host verdict certification before
  `fullAuthorityDone`;
- non-authority local mode staying local-only and never reporting Authority DONE.

Primary files touched by this validation effort:

- `packages/main/src/core/authority-client.ts`
- `packages/main/src/core/planned-steps-executor.ts`
- `packages/main/src/tasks/authority-client-smoke.ts`
- `packages/main/src/tasks/authority-enforce-matrix-smoke.ts`
- `packages/main/src/tasks/authority-live-python-e2e-smoke.ts`
- `packages/main/src/tasks/authority-live-python-full-e2e-smoke.ts`

## Final Scope

The evidence in this bundle is enough to claim:

```text
Proofbound CLI non-authority PASS
Proofbound CLI + remote Proofbound Authority authorityDone PASS
Proofbound CLI + remote Proofbound Authority fullAuthorityDone PASS
```

It does not claim that every future arbitrary project or every cross-language
redevelopment workload is already proven. Those broader product claims still
require the separate baseline suite defined in `docs/lattice/legacy/root-markdown/Lattice-baseline.md` (archived from repository root).
