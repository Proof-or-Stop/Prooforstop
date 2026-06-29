# Proofbound Authority Unattended Development Requirements

> **Retired legacy note:** Authority Server and server-backed receipt semantics in this document are retired/out-of-core for the active Proofbound CLI. Current implementation baselines are local proof admissibility (`admissibilityStatus`, `assuranceLevel`, `evidenceScope`), gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance. Do not use this document as active Authority Server implementation guidance.

## Status

This document is the single requirements source for developing the Proofbound
Authority-backed unattended development path.

It combines two previously separate stages into one coordinated product track:

- **Stage A: Authority control plane and receipt foundation.** Proofbound CLI must
  connect to the existing Python Proofbound Authority, use native signed envelopes,
  register and heartbeat runners, claim authority jobs, and verify native
  `gate_decision` receipts.
- **Stage B: Authority-backed unattended executor.** Proofbound CLI must consume
  authority jobs, execute bounded development steps, upload evidence, request
  gate evaluation, verify the returned receipt, retry or stop safely, and advance
  toward TEST / DONE without human babysitting.
- **Stage C: Proofbound-native planner.** Proofbound must turn a natural-language
  request into a Proofbound Story, verification intent, Authority job, and typed
  `plannedSteps[]` without handing story, job, or receipt authority to an
  external framework.

The stages are developed together because Stage A without Stage B only proves
connectivity, Stage B without Stage A would be local automation that cannot
claim production authority, and Stage B without Stage C still requires someone
or something else to prepare the Story and executable plan.

The existing Python implementation lives at the legacy repository path:

```text
/Users/jek/Documents/Work/Lattice/cord-team
```

The product and server name is **Proofbound Authority**. The repository path and
Python package entrypoint may keep legacy names during migration, but all new
product copy, CLI help, API docs, tests, environment variables, and process facts
must use Proofbound Authority naming.

## Customer Server Access Boundary

Hosted customer usage requires a customer-scoped server API key in addition to
the existing Ed25519 actor signing model. The customer API key authorizes the
tenant / workspace / project to use Proofbound Authority APIs; the actor private
key signs the exact runner, job, evidence, verdict, and gate envelopes. These
two credentials are intentionally separate and must not be collapsed into one
bearer token.

Production mutating APIs must require both:

- `Authorization: Bearer <LATTICE_AUTHORITY_CUSTOMER_API_KEY>` for
  customer/project authorization;
- a signed actor envelope for action integrity, role binding, and nonce replay
  protection.

The detailed production access model, `authority.md` shape, redaction rules,
server storage requirements, and test matrix are defined in
[`lattice-authority-customer-api-key-access.md`](lattice-authority-customer-api-key-access.md).
That model is part of production Authority readiness: actor registration,
evidence upload, gate evaluation, and verifier verdict submission must not be
validated as production-ready unless the correct credential boundary is
exercised. Actor registration is customer-key and project/role scoped; after
actor enrollment, production mutating APIs require both customer API key
authorization and actor signature verification.

## Current Capability Baseline

The current codebase now has the core unattended-development loop in place:

- local autopilot mode works without Python authority;
- shadow mode can surface authority readiness without blocking local work;
- authority mode fails closed when prerequisites are missing;
- Proofbound CLI can discover policy from Proofbound Authority;
- Proofbound CLI consumes operator/server-provided Authority handoff files. The
  ordinary developer pair is `lattice_authority_trust.env` plus its referenced
  `lattice_staging-client.env`; advanced/live runner handoff may provide the
  `lattice_senior_*` pair. Public CLI code does not generate those files. A
  single server-generated senior bundle may be reused across host providers by
  setting `LATTICE_AUTHORITY_RUNNER_PROVIDER` on each host. The CLI treats the
  value as a host-neutral non-empty provider declaration, defaults it to
  `codex`, preserves `claude` / `CLAUDE_CODE` alias compatibility as
  `claude-code`, and propagates custom declarations such as `codex-cli` or
  `antigravity` to runner registration, heartbeat, and signed claim routing.
  Server policy remains the authorization boundary and may reject a declaration
  before any job is owned;
- Proofbound CLI has a native receipt verifier for Python-shaped
  Proofbound Authority receipts;
- live authority mode can register / heartbeat, read
  `/v1/runners/{runnerId}/jobs/stream` as an authenticated `jobs.available`
  notification hint, claim a real Authority job through the existing signed
  claim endpoint, execute its typed `plannedSteps[]`, upload evidence, request
  `gate.evaluate`, verify the returned native `gate_decision` receipt, and
  complete-or-release the lease without leaving a dangling claim;
- the planner can turn a natural-language request or request file into a
  Proofbound Story, typed JobPlan, and executable `plannedSteps[]`;
- local Proofbound workflow and global `lattice` entrypoints remain usable.

The loop is still deliberately bounded. A bundled local-test Authority key
(`serverKey.productionInert=true`) proves local integration only and cannot
satisfy production Authority DONE. Production Authority DONE still requires a
non-inert Proofbound Authority server key, a verified native `gate_decision`
receipt, and the required multi-host final verification wave.

## Implementation Status (2026-06-06)

This section records what is implemented in the Proofbound CLI today versus what
must still not be overclaimed. It is a status ledger, not a relaxation of any
gate. The current pass implements the planner, bounded executor, live Authority
job loop, evidence / gate / receipt wiring, repair / retry safety, and
multi-host certification gates needed for the documented unattended path.

Implemented (current tested surface):

- autopilot modes: `autopilot status|doctor|run|execute`. `run` is dry-run
  projection by default; `execute --mode=local` is a real bounded executor over
  argv-mapped Proofbound commands; `execute --mode=authority` is fail-closed and
  acts as a native `gate_decision` receipt verifier, not a receipt minter
  (`packages/main/src/core/autopilot.ts`, `autopilot-executor.ts`);
- claimed-job entry point: `autopilot execute --jobFile=<job.json>` loads and
  validates a claimed Authority job envelope (`parseClaimedAuthorityJob`) and
  consumes its typed `plannedSteps[]` through the shared bounded executor
  (`consumeClaimedAuthorityJob`) instead of synthesizing local argv steps. The
  loader fails closed on an unreadable file, malformed JSON, a bad job envelope,
  or a `--storyId` / `--mode` mismatch (`stopReason=claimed-job-file-invalid` or
  `claimed-job-{story,mode}-mismatch`). This is the command-surface seam only:
  authority DONE stays gated by a verified native `gate_decision` receipt — the
  `gate.evaluate` step blocks `authority`+`DONE` so a claimed job never
  self-claims `authorityDone`, and the executor still does not call
  `POST /v1/gates/evaluate`, drive evidence upload, or mint a receipt
  (`packages/main/src/core/autopilot-executor.ts`,
  `packages/main/src/core/authority-runner.ts`);
- authority client primitives: policy discovery (`authority enforce policy`),
  Ed25519 native signing, native receipt verifier (`authority receipt verify`),
  and a runner control plane that can register / heartbeat / read the optional
  jobs-available SSE hint / claim / release without provider execution
  (`authority-client.ts`, `authority-signing.ts`, `authority-runner.ts`). The
  jobs stream is diagnostic only: empty snapshots, unsupported/old servers,
  HTTP errors, timeouts, malformed payloads, and non-SSE bodies all fall back to
  the same signed claim path. The evidence-submit primitive exists and is
  exercised by smoke tests;
- `lattice story resolve` read-only worktree/phase resolver
  (`packages/main/src/handlers/story-resolve.ts`);
- planner surface: `planner draft|review|create-story|create-job|status|run|
  source-manifest` plus `--interactionMode` and the
  `answer` / `decision submit` / `resume` pause path
  (`packages/main/src/core/planner.ts`, `handlers/planner.ts`);
- `planner run` no longer stops at the job plan. By default it composes
  draft -> review -> Story -> job/local plan and then consumes the typed
  `plannedSteps[]` through a deterministic local/fake executor
  (`packages/main/src/core/planned-steps-executor.ts`); `--planOnly` (or
  `--execute=false`) keeps it plan-only. That executor is a deterministic
  projection, not the live Stage B loop: `provider.fake` steps pass but are
  marked `productionAuthorityEligible: false`, `provider.codex` /
  `provider.claude` steps fail closed before any spawn unless explicitly enabled
  in `providerPolicy.allowedProviders` with a configured credential (`disabled` /
  `provider_unavailable` / `credential_unavailable` / `noninteractive_auth_unavailable`),
  `story.advance` returns `blocked` so Proofbound lifecycle gates are never
  bypassed, and for `until=DONE` `multiHostVerified` always stays `false`
  (host verdicts are owned elsewhere). The authority `gate.evaluate` step is
  now wired to Proofbound Authority: `planner run` calls
  `resolveAuthorityGateEvaluator` (`authority-client.ts`) BEFORE execution,
  which — only when `LATTICE_AUTHORITY_MODE` is `enforce`/`shadow`, a server
  URL is set, and a server verification key is pinned or discovered — appends
  run + evidence events (`POST /v1/runs/{id}/events`, `POST /v1/evidence/batch`),
  requests `POST /v1/gates/evaluate`, and verifies the returned native
  `gate_decision` receipt via the existing client verify path. A verified
  approve projects per-run `authorityDone:true` / `receiptVerified:true`; every
  other path (mode off, no URL, no server key, reject/blocked decision, or
  unverified/tampered receipt) FAILS CLOSED — the executor blocks at the gate
  with `authority_gate_decision_receipt_required` (or the specific decision
  reason) and `authorityDone` / `receiptVerified` stay `false`. The CLI never
  mints a receipt, and local/non-DONE jobs still make zero network calls and
  record evidence only as a local `planner_execution` process event;
- verdict surface (M16, multi-host final verification): local
  `autopilot review submit|status` stay LOCAL-storage backed (verdict JSON under
  `.lattice/`) and never set authority flags. The authority commands
  `authority verdict submit|list` and `authority job status`
  (`packages/main/src/core/verdicts.ts`, `handlers/verdict.ts`) are now
  SERVER-backed when authority config is present — `resolveAuthorityVerdictBacking`
  (`authority-client.ts`) routes them through `AuthorityClient.submitJobVerdict` /
  `listJobVerdicts` iff authority mode is `enforce`/`shadow` AND a URL is set,
  otherwise it falls back to the same local storage (off / no-URL callers make zero
  network calls, the exact runner-client gate). Mechanical guarantees, pinned by
  `tasks/multi-host-authority-smoke.ts`: (a) receipt-before-verdict ordering — an
  authority verdict submission missing the `checkedReceiptId` /
  `checkedGateInputDigest` it inspected is rejected BEFORE any POST
  (`checkReceiptBeforeVerdict`), so a verdict can never be recorded ahead of its
  receipt (§X9 Authority ordering); (b) `authority job status` combines the
  server-computed reconciliation with a per-run native `gate_decision` receipt
  verification (`reconcileAuthorityCertification`) — `fullAuthorityDone` requires
  BOTH a verified per-run receipt (supply `--receiptFile`) AND a satisfied
  independent-host reconciliation; without the receipt `authorityDone` /
  `fullAuthorityDone` stay false even on a satisfied wave; (c) multi-host
  disagreement blocks with `multi_host_disagreement` and a `block` /
  `repair_then_reverify` nextAction; (d) a repair that mints a fresh receipt makes
  prior verdicts stale — server-side via `partitionFreshWaveVerdicts` (verdicts
  that checked a prior receiptId) and locally via `summarizeVerdicts`'
  `currentAnchor` filter (verdicts whose validation/material anchors changed) — so a
  fresh review wave is required. This is the final certification COMMAND/API phase,
  not a new `plannedSteps[]` step type and not an executor that spawns verifier
  hosts (host invocation stays operator/coordinator-driven, §X9);
- server-side multi-host verdict client (`POST/GET /v1/jobs/{jobId}/verdicts`):
  `AuthorityClient.submitJobVerdict` / `listJobVerdicts`
  (`packages/main/src/core/authority-client.ts`) with typed contracts in
  `authority-contracts.ts` (`AuthorityVerdictClaim` submission,
  `AuthorityVerdictReceipt`, `AuthorityVerdictReconciliation`, list/submit results).
  This is a thin transport primitive only — the same role `submitEvidence` plays for
  evidence — consumed by the Stage B executor / release-certification phase,
  NOT a new orchestration loop. Three boundaries are mechanically enforced at the
  client/contract layer (fake-server smoke in `tasks/authority-client-smoke.ts`):
  (1) the POST receipt kind is `host_verdict` and a `gate_decision`-kinded receipt
  from the verdict endpoint fails schema validation (overclaim → client `error`), so a
  host opinion can never be laundered into a production-DONE receipt; (2) the client
  surfaces the Authority-computed reconciliation (`independentHostCount` /
  `satisfied`) and never recomputes independence from self-reported body fields — the
  submission body carries no client-asserted `hostId`; (3) a satisfied multi-host
  reconciliation is still NOT authority DONE — the local-review summarizer keeps
  `authorityDone` / `fullAuthorityDone` / `multiHostVerified` false on a passing wave,
  and `fullAuthorityDone` continues to require per-run `authorityDone` (a verified
  native `gate_decision` receipt) PLUS the passing wave;
- machine-readable JobPlan policy blocks (§B1): every JobPlan — local AND
  authority — now carries `providerPolicy`, `worktreePolicy`, `retryPolicy`,
  `stopPolicy`, `lease`, `evidencePolicy`, and `receiptPolicy` alongside the
  existing `multiHostPolicy`, emitted with conservative fail-closed defaults
  (`buildJobPlan` / `buildJobPolicyBlocks` in `packages/main/src/core/planner.ts`):
  fake-only `providerPolicy` with `providerAvailability=fail_closed`, no fallback,
  and no production-DONE eligibility; `worktreePolicy` with
  `resolver=lattice.story.resolve`, `preserveUnrelatedDirtyChanges=true`,
  `requireGitStatusEvidence=true`, story/fixture JSON in `forbiddenPathGlobs`, and
  `requiresAuthoritativeWorktree` defaulting true only in authority mode; disjoint
  `retryPolicy` / `stopPolicy` (§B5); a pre-claim `lease` whose claim-time fields
  are null but whose `renewalThresholdMs < leaseTtlMs`; a redaction- and
  checklist-coverage-required `evidencePolicy` over the §B4b retention classes; and
  a `receiptPolicy` requiring a `gate_decision` receipt with the 600000/300000
  freshness/skew defaults. `assertJobPolicyConsistency` is the JobPlan-level review
  gate: it throws (so the plan is never treated as planned) on a missing block,
  mixed retry/stop fields, fallback to a non-allowed provider, dropped dirty-change
  preservation, renewal at/after lease expiry, non-positive receipt freshness, or
  an inconsistent multi-host floor. The runtime executor consumes these same
  blocks fail-closed: provider availability / credential policy gates bounded
  provider spawns, `worktreePolicy` gates mutating provider cwd + dirty-state
  safety, `retryPolicy` / `stopPolicy` bound repair attempts, `evidencePolicy`
  drives upload/redaction/retention decisions, and `receiptPolicy` requires a
  verified native `gate_decision` receipt before any Authority DONE projection;
  runtime linkage (B-e3d9): `requiresAuthoritativeWorktree` is emitted by
  `buildJobPolicyBlocks`, checked by `assertJobPolicyConsistency`, and enforced
  by `evaluateWorktreePreflight` as `authoritative_worktree_unresolved`;
  `requiresCleanWorktree` is carried by mutating provider steps and by the
  policy-level override path, both covered by `worktree-policy-smoke` as
  `dirty_worktree` with unrelated dirty changes preserved;
- Source-Aligned Redevelopment as a planner workflow: spec schema, validation,
  `planner source-manifest` deterministic source digest, and a deterministic
  plannedSteps-executor evidence projection for the `language.*` / `source.*` /
  `target.*` operations. The projection resolves adapter availability (block vs
  `scoped_gap`), emits language-neutral manifest records, derives
  manifest-backed alignment maps and `gapList[]`, builds the parity-oracle
  catalog, and records target-runnable parity as `not_run` /
  `targetParityVerified=false` so it never overclaims target parity. See
  `C2a-projection` for the exact projection contract. Still planning/projection
  only: no live adapter, no real target build, no production redevelopment DONE.
- Stage B job-loop lease/heartbeat semantics (§B1 lease / §B7 loop tail / §B12 /
  §B17): `core/authority-job-loop.ts` is the deterministic lease state machine
  over a claimed job lease (`createAuthorityJobLoop`). It parses a
  claimed lease (`parseClaimedLease`, fail-closed on missing
  leaseId/runnerId/sessionId/expiry or `renewalThreshold >= ttl`), heartbeats at
  the §B12 loop phases (`after-claim` / `before-step` / `after-step` /
  `before-gate` / `before-release` / `before-completion`), promotes a heartbeat
  to a renewal once the clock crosses `leaseExpiresAt - renewalThresholdMs`
  (bumping `leaseVersion`), and reports lease health (`safe` / `grace` /
  `expired`). Completion FAILS CLOSED on an unsafe lease — `grace` and `expired`
  both refuse to complete (`graceMs` is diagnostic only, never used to claim
  DONE), and a server stale-version rejection surfaces `stale-lease:version`.
  Completion also fails closed unless a required gate receipt is verified AND the
  final policy is satisfied; otherwise the job is released, not completed.
  Release and complete are idempotent (a retried call never double-fires the
  transport nor produces a conflicting record). `finalizeAuthorityJob` drives the
  §B7 tail (heartbeat → complete-or-release, never dangling), and
  `finalizeConsumedAuthorityJobLease` (`authority-runner.ts`) maps a
  `consumeClaimedAuthorityJob` disposition onto that lease lifecycle.
  `core/authority-job-loop-live.ts` wires this safety boundary to the live
  Authority client path used by `autopilot execute --mode=authority`: register /
  heartbeat / claim, map the real Python `JobRecord.spec.plannedSteps` and lease
  fields, resolve the live gate evaluator, consume the job through the shared
  plannedSteps executor, then complete or release the lease. Covered by
  `tasks/authority-job-loop-smoke.ts` and `tasks/authority-job-loop-live-smoke.ts`;
- M15 Natural-Language-To-DONE E2E: `tasks/natural-language-to-done-smoke.ts`
  drives the whole Stage C→B chain through the REAL planner handler
  (`createPlannerHandlers` over a real `StoryStore`): a one-sentence request AND
  an identical `--requestFile` each plan a real Proofbound Story, build the typed
  authority JobPlan, and run `executePlannedSteps` (fake provider → validate →
  run-events/evidence upload → `gate.evaluate`). The only stubbed surface is the
  Authority server, through the SAME injectable seam production uses —
  `resolveAuthorityGateEvaluator`'s `{ env, fetchImpl, now }`, now surfaced on
  `HandlerContext.authorityGateOptions` and consumed by `planner run`. Production
  leaves that field unset, so the resolver still reads `process.env` + the real
  fetch and stays byte-identical / fail-closed; the E2E sets it to a stub that
  mints a properly Ed25519-signed native `gate_decision` receipt bound to the
  planner-generated project/story, so the REAL native verifier runs and a verified
  approve projects per-run `authorityDone:true` / `receiptVerified:true` with
  `fullAuthorityDone:false` (multi-host owned elsewhere). The seam never relaxes
  the gate: the same E2E asserts the fail-closed path (no server config → blocked
  with `authority_gate_decision_receipt_required`, `authorityDone:false`) and the
  reject path (server answers, no verified receipt → blocked,
  `authority_gate_decision_rejected`, never laundered into DONE), plus duplicate
  intake reusing one Story, and a Source-Aligned Redevelopment run that completes
  its plannedSteps but stays `doneEligible:false` because no target-runnable parity
  evidence is captured (no overclaim). This proves the loop end to end against a
  signing-correct stub server through the same resolver/fetch seam production
  uses. Live Python control-plane evidence is covered separately by
  `tasks/authority-live-python-smoke.ts` when `LATTICE_AUTHORITY_LIVE_URL` and the
  pinned server public key are provided; a local-test server
  (`serverKey.productionInert=true`) proves integration only, not production DONE;
- M10 / M11 authority completion gate + loop: `core/authority-completion.ts`
  adds the single FAIL-CLOSED completion decision (`evaluateAuthorityCompletion`)
  that the executor result alone could not make. Per-run `authorityDone` requires
  a verified native `gate_decision` receipt (from the executor's gate step) PLUS a
  completed (validation-passed) run; `fullAuthorityDone` ADDITIONALLY requires the
  multi-host final verification gate when `multiHostPolicy.requireMultiHost` /
  `fullAuthorityDoneRequired` demands it (independence count + `satisfied` are read
  from the Authority/local reconciliation, never recomputed), and the job
  `completed` flag is the per-mode DONE projection. Every failure path leaves the
  DONE flags false with an explicit machine-readable blocking reason: reject →
  `authority_gate_decision_rejected`; tamper / wrong key / wrong story / wrong
  project / missing decisionDigest / stale / future-dated all collapse to
  `authority_gate_receipt_unverified`; blocked / unavailable / error / no-config /
  incomplete-validation / unmet-multi-host each map to their own reason. Receipt
  refs are recorded for traceability even on a blocked run (`verified:false` unless
  a verified-approve receipt). `runAuthorityCompletionLoop` is the B7/B16
  orchestration that composes the existing primitives end to end —
  `resolveAuthorityGateEvaluator` (append run + evidence events → automatic
  `POST /v1/gates/evaluate` → verify the native receipt) → `executePlannedSteps`
  → `evaluateAuthorityCompletion` → the B16 `lattice.authority_job_completion.v1`
  final output (receipt refs, evidence refs, host verdict refs, DONE flags, stop
  reason). It adds NO new network path and NO new minting; local / non-authority
  and authority/non-DONE jobs make zero authority calls and never project an
  authority DONE flag. `completionToFinalizeInput` bridges the verdict into the
  separate `authority-job-loop.ts` lease state machine's complete-or-release tail
  (verdict.completed → `finalPolicySatisfied`), so the lease completes only when the
  completion gate already allows it. Covered by
  `tasks/authority-completion-smoke.ts` (pure-decision matrix + end-to-end loop
  against a signing-correct stub server, including the reject / tamper / stale /
  future / wrong-story fail-closed paths). The live `autopilot execute
  --mode=authority` path now threads the resolved gate evaluator and completion
  verdict through `consumeClaimedAuthorityJob`, so the operator-facing
  `authorityJobLoop.receiptVerified` trace reads the same final completion verdict
  as the top-level result;
- worktree-safety runtime enforcement (§B2 / M7 / M9 / M11):
  `core/worktree-policy.ts` turns the planner-emitted `worktreePolicy` block into
  real executor behavior, consumed by `executePlannedSteps`
  (`core/planned-steps-executor.ts`). Before any MUTATING provider step
  (`provider.codex` / `provider.claude`; `provider.fake` is fixtures-only and
  exempt) it resolves the authoritative story cwd via the same
  `lattice.story.resolve` contract that powers `lattice story resolve`, runs the
  provider IN that worktree (never the project root), and captures
  `git status --porcelain` as structured evidence (digest + entries). It fails
  CLOSED — blocking the step and emitting a printable/uploadable
  `lattice.worktree_stop_summary.v1` plus a `worktreeStop` process event — on an
  unresolved authoritative worktree (`authoritative_worktree_unresolved`), missing
  git status evidence when `requireGitStatusEvidence` is set
  (`git_status_evidence_unavailable`), a dirty worktree when the step/policy
  requires a clean one (`dirty_worktree`, preserving unrelated dirty changes rather
  than discarding them), or a forbidden-path edit — declared up front OR introduced
  by the provider — to the non-droppable story/fixture JSON globs
  (`forbidden_path_glob`). Enforcement is gated on the JobPlan actually carrying a
  `worktreePolicy` block, so local mode and legacy/synthetic plans keep working;
  the `gitRunner` is injectable for deterministic smokes
  (`tasks/worktree-policy-smoke.ts`). Still NOT covered here: worktree *repair*
  (`allowWorktreeRepair`) is never performed, the enforcement only wraps the
  single-pass `executePlannedSteps` loop (not the outer repair/retry adapter), and
  it does not commit, merge, or push — lifecycle gates still own those.

Remaining boundaries that must not be overclaimed:

- `provider.codex` and `provider.claude` are REAL bounded executors, not just
  planned step types. Each runs through a dedicated bounded runner
  (`providers/codex-cli.ts` `runBoundedCodexProvider`,
  `providers/claude-cli.ts` `runBoundedClaudeProvider`) that the default
  `BoundedProviderExecutor` dispatches to: a single argv-mapped, stdin-closed CLI
  invocation per attempt with explicit cwd, redacted env, hard timeout, and an
  attempt cap, capturing stdout/stderr/exit/duration as DIGESTS only
  (+ best-effort model) and retrying only on timeout. `provider.claude` is gated
  behind explicit `providerPolicy.allowedProviders` enablement and a credential
  policy: it fails closed BEFORE any spawn on a disabled provider (`disabled`),
  an unbounded request (`provider_request_invalid`), a missing CLI
  (`provider_unavailable`), a missing configured credential
  (`credential_unavailable`, sourced only from
  `providerPolicy.credentialsEnvAllowlist` / `secretRefs`), and
  `noninteractive_auth_unavailable` when no allowlisted noninteractive Claude
  credential is present. Provider evidence records an env redaction summary and
  never inlines a secret value; provider success is never validation success,
  prose evidence, or authority DONE. The smokes prove the real spawn seam against
  controlled temp binaries and fail-closed policy paths; production use still
  depends on the user's installed, noninteractive Codex/Claude CLI credentials;
- live `autopilot execute --mode=authority` now drives the Stage B loop:
  register / heartbeat / claim, map the real Python `JobRecord.spec` shape,
  execute bounded `plannedSteps[]`, upload durable evidence refs, call
  `gate.evaluate`, verify the native receipt, evaluate completion, and complete
  or release the lease. The loop uses bounded timeouts and a one-hour live lease
  request so ordinary provider steps can finish without a stale 60-second lease.
  It is not an infinite daemon and does not claim to keep arbitrarily long tasks
  alive with background heartbeats beyond the configured lease/budget policy;
- Python Authority terminal semantics are explicit: `POST /v1/jobs/{jobId}/release`
  releases/requeues a lease and its body has no `outcome`. A completed job is
  completed by appending a signed `response.completed` run event to
  `POST /v1/runs/{runId}/events`. If that completion event cannot be appended,
  the runner releases fail-closed with a bounded reason instead of projecting
  DONE from a release call;
- Python Authority gate semantics are explicit: `POST /v1/gates/evaluate`
  receives a signed `{ decision: ... }` envelope from a gate-capable actor role
  (`main` or `human`). Runner actors cannot request the gate. The CLI
  supports separate `LATTICE_AUTHORITY_GATE_ACTOR_*` signing material and fails
  closed when no gate-capable signing key is configured;
- `planner run` can produce the Story/job/typed steps and execute the
  deterministic local/fake path end to end. Production natural-language-to-DONE
  in authority mode is eligible only when the generated job uses production-
  eligible providers, live Authority server config is present, the native
  `gate_decision` receipt verifies, and the required multi-host final
  certification wave is satisfied;
- the local live Python smoke proves policy discovery plus runner
  register/heartbeat/jobs-stream-hint/claim/release against a real Proofbound
  Authority server. The jobs stream is a notification hint before claim, not a
  lease, receipt, completion event, or Authority approval. When the server
  reports `serverKey.productionInert=true`, that evidence is
  integration evidence only and must not be treated as production Authority DONE;
- server-side native `gate_decision` receipt issuance is owned by Proofbound
  Authority. The CLI verifies and consumes those receipts; it never mints one.

M8 per-step evidence streaming (2026-06-06). The §B4 evidence taxonomy now has
a standalone executor-driven streaming layer in
`packages/main/src/core/evidence-uploader.ts`, plus a synchronous per-step
`evidenceRecorder` seam on `executePlannedSteps`
(`planned-steps-executor.ts`). The layer turns the deterministic executor's
per-step output into structured, digest-only evidence records — a leading
`run_record`, one record per step classified by type (`provider_event` /
`command_event` / `validation_evidence` / `gate_request` / `stop_summary`), and
a run-level `git_evidence` record built from injected git state. Python event
endpoints receive one signed event per POST: provider evidence is sent as a
`providerEvent` envelope to `POST /v1/runs/{runId}/provider-events`, and run
events are sent as an `event` envelope to `POST /v1/runs/{runId}/events`.
Internal Proofbound evidence taxonomy is preserved locally, but payloads sent to
Python `/v1/evidence` use Python `EvidenceKind` values such as `docs_check` or
`logic_test`, never internal-only kinds such as `run_record`. Three boundaries
are mechanical, pinned by `evidence-upload-loop-smoke`:

- LOCAL mode writes local evidence ONLY — zero network calls (the client is
  never consulted) and a single digest-only `planner_evidence_local` process
  event when a store is supplied;
- AUTHORITY mode FAILS CLOSED on a required-evidence upload failure: the stream
  stops at the first required record whose transport outcome is not `success`
  and returns `status:"blocked"` with an EXACT
  `evidence_upload_failed:<kind>:<stepId>:<transport>` reason (an unconfigured
  authority client fails closed before any network with
  `authority_evidence_client_unconfigured`); a non-required failure is recorded
  (`uploaded:false`) but does not block only when
  `evidencePolicy.allowContinueWithoutEvidence` is set;
- the client NEVER mints a receipt here — the layer only POSTs evidence and
  reads the transport ack kind (`receiptMinted` is a permanent `false`), so it
  never verifies, derives, or projects DONE.

The live gate path now pre-registers the same durable evidence refs the executor
emits (`plannerRunId:stepId:kind`) and passes a
`gateEvidenceRefResolver` into `executePlannedSteps`, so the gate input and
uploaded execution evidence agree mechanically. `git_evidence` remains bounded:
it is captured through the executor/worktree policy or injected test seam, and
the system must not infer unobserved repository changes from prose output.

Minimal-projection gaps surfaced by acceptance smokes (2026-06-06). These are the
honest boundaries of the current deterministic projection; the
`planner-unattended-smoke` test pins each one so it cannot be silently overclaimed:

- `no_progress` has two layers now. (1) The single-pass projection inside
  `executePlannedSteps` still classifies one provider step whose bounded retry
  budget (`maxAttempts > 1`) is exhausted with every attempt timing out as a
  blocked `no_progress` stop. (2) The full §B5 outer repair/re-validate loop —
  the M9 gap — is now implemented as a standalone, dependency-injected engine in
  `packages/main/src/core/repair-retry-loop.ts` (`runRepairRetryLoop`) with an
  executor-level provider adapter (`executeProviderBackedRepairRetry` /
  `resolveRepairRetryPolicy` in `planned-steps-executor.ts`). The engine runs the
  bounded `validate -> (fail) -> configured repair provider step -> revalidate`
  loop, retries provider timeouts inside each repair step, and counts
  cross-iteration no-progress with a material/evidence hash so `maxRepairAttempts`
  and `maxNoProgressIterations` produce distinct exact blocked stop reasons
  (`max_repair_attempts_exhausted` / `no_progress` /
  `repair_provider_unavailable` / `repair_provider_failed` / `repair_not_allowed`).
  Hard invariants hold in every branch: repair always revalidates and never
  satisfies validation by itself, and `authorityDone` / `receiptVerified` /
  `multiHostVerified` stay `false`. `repair-retry-loop-smoke` pins all branches.
  The engine is now WIRED INTO `executePlannedSteps` itself: a failing
  `validate.run` step whose JobPlan opts in (`retryPolicy.repairAllowed:true` plus
  a resolvable provider `repairBinding`) drives the bounded loop inline via
  `maybeRunValidateRepairLoop` instead of a single-pass stop — every repair
  attempt + revalidation is recorded (tagged `repairLoopAttempt`), and the run
  stops `blocked` with the exact loop reason (`no_progress` /
  `max_repair_attempts_exhausted` / `repair_provider_unavailable` /
  `repair_provider_failed`). Repair is strictly scoped to `validate.run` failures,
  so a gate/receipt failure can never be repaired into DONE (it stops/releases per
  `stopPolicy`). The default planner emits `repairAllowed:false`, so the
  single-pass projection path (and its provider-step `no_progress` classification)
  is unchanged. `repair-retry-integration-smoke` pins the wired path end-to-end
  through `executePlannedSteps`. Remaining bounded-test boundary: the convergence
  (repair fixes validation) branch cannot be exercised through the deterministic
  `executePlannedSteps` path because `validate.run` is deterministic over a static
  `coverageMap` and cannot flip fail→pass without a live validation reading real
  worktree state changed by a real repair provider; that branch is covered at the
  engine level by `executeProviderBackedRepairRetry` in `repair-retry-loop-smoke`.
  Gate/receipt failures remain non-repairable by design and release/block per
  `stopPolicy`;
- `--forceNewRun` / `--forceNewRunReason` are wired into a distinct planner
  idempotency scope (`buildPlannerDraft` in `packages/main/src/core/planner.ts`).
  The default planner run id stays deterministic from the full natural-language
  intake digest plus interaction mode, so an identical request without the flag
  reuses the same run/Story scope (idempotent). When `--forceNewRun` is supplied
  it fails closed unless `--forceNewRunReason` is a non-empty string, then forks a
  reason-keyed scope digest that diverges plannerRunId, the Story name (so
  story_create does not reuse the default Story), and the job plan — while
  `naturalLanguageDigest` stays request-only. The fork is deterministic per
  reason (a repeated forced run with the same reason collapses back onto the
  forked scope), and `forceNewRun` / `forceNewRunReason` / `forceScope` are echoed
  in the planner draft and job plan JSON and folded into `plannerDigest` /
  `jobPlanDigest` so the fork is mechanically auditable;
- budget metering is implemented (X6 + §B5 stopPolicy + §B16 `budgetUsage`).
  Every JobPlan now carries a `budgetPolicy` block (`buildJobPolicyBlocks` in
  `packages/main/src/core/planner.ts`) derived from `plannerPolicy`
  (`maxWallClockMs` / `maxTokenOrCostBudget` / `maxProviderCalls`), and
  `assertJobPolicyConsistency` rejects a negative / non-finite budget field. The
  executor wires a single side-effect-free meter
  (`packages/main/src/core/budget-meter.ts`) that tracks wall-clock,
  provider-call, and known token/cost usage from planner/provider/executor step
  events. When any enabled bound is crossed the run stops fail-closed with
  `status=blocked`, `stopReason=budget_exceeded`, a populated `budgetUsage`
  snapshot, and a next action — BEFORE the gate step, so authority DONE is
  unreachable on exhaustion and budget exhaustion never triggers provider
  fallback, extra review waves, or silent scope reduction. A `0` limit disables
  that dimension (an unknown token budget stays `0`); CLI overrides may only
  TIGHTEN a plan budget (`resolveBudgetLimits` reduce-only, §B9). Local and
  authority fail-closed behavior is pinned by `tasks/budget-meter-smoke.ts`.
  Remaining boundary: provider-call and wall-clock budgets are enforced for real
  Codex/Claude spawns, but token/cost details are known only when the provider
  output exposes parseable usage; otherwise the meter records
  `tokenOrCostKnown=false` and falls back to provider-call + wall-clock budgets
  (X6).
- evidence retention/GC and content redaction now have runtime engines wired into
  executor upload evidence. Every JobPlan emits
  `evidencePolicy.redactionRequired` plus a per-kind `retentionClassByKind` map
  (§B4a / §B4b), and `assertJobPolicyConsistency` rejects an unknown retention
  class. `core/evidence-redaction.ts` is the runtime content-redaction pass:
  `redactText` / `redactEvidence` strip private keys, Authorization/Bearer/Basic
  schemes, session cookies, named secret assignments, and known opaque token
  shapes from stdout/stderr/prompts/notes before upload while preserving the
  original artifact digest in a `redactionSummary` (so a verifier can still match
  the unredacted local artifact, §B4a). `core/evidence-retention.ts` is the
  runtime retention layer: `evaluateRetention` / `sweepRetention` /
  `runRetentionSweep` are a deterministic, fail-closed GC that deletes ONLY
  expired non-receipt-bound artifacts and protects `receipt_bound_artifact`
  records inside their window, `final_summary` records (kept queryable forever),
  and `protected` receipt JSON / final host verdict records. The
  `evidence-retention-gc-smoke` acceptance test drives real redaction AND a real
  GC deletion sweep (proving receipt-bound / final / protected artifacts survive
  while expired logs are deleted) — closing the prior "no GC path to drive" gap.
  `redactedProviderEnv` (planned-steps-executor) remains the env-projection seam.
  The live upload path redacts before transport and attaches retention metadata to
  uploaded envelopes (`evidence-live-wiring-smoke`); durable server-side GC
  scheduling is still owned by Proofbound Authority storage operations, while the CLI
  retention engine proves the local decision logic.

Because of these boundaries, Proofbound may claim the tested unattended local mode
and the tested Authority-backed per-run loop. It must not claim production
Authority DONE unless a non-inert Proofbound Authority server verifies the native
`gate_decision` receipt and the required independent-host final certification
passes.

## Product Goal

Proofbound should support unattended development in two user-selected development
modes:

| User-selected mode | Goal | Authority dependency | Production DONE claim |
| --- | --- | --- | --- |
| `local` / `non-authority` | Pure client-side bounded autopilot for development and validation. It must not connect to Proofbound Authority. | None. | No. |
| `authority` | Proofbound CLI client plus Proofbound Authority server strong-verification mode. | Required. | Yes, only after verified native `gate_decision` receipt. |

`shadow` is an explicit diagnostic/readiness mode, not a third user-selected
unattended development mode. It may inspect Authority readiness when requested,
but it must not be used to claim local non-authority purity or production DONE.

The product goal is not "run a model forever." The goal is a bounded,
receipt-backed development loop that can be inspected, resumed, and stopped.

For complete unattended development, the product goal extends to:

```text
natural language request
-> Proofbound-native Story Planner
-> Proofbound Story + background + checklist + verification intent
-> Proofbound-native Job Planner
-> local run plan or Authority job + typed plannedSteps[]
-> Stage B executor
-> evidence upload
-> local review certification or gate_decision receipt
-> selected-mode DONE or blocked
```

## Non-Goals

This track must not:

- redevelop the Python server from scratch;
- make ordinary local Proofbound commands depend on Python authority;
- allow non-authority mode to contact Proofbound Authority;
- allow env presence, runner heartbeat, job claim, or transport acceptance to
  satisfy DONE;
- allow bundled default test keys to satisfy production Authority DONE;
- treat legacy subject receipts as native Proofbound Authority DONE receipts;
- write story or fixture JSON directly instead of using Proofbound commands;
- run arbitrary shell commands from authority jobs;
- hide failed verification behind a green local status;
- auto-push to remote Git or create GitHub branches unless a human explicitly
  asks outside the Proofbound flow;
- make `obra/superpowers` or any other external methodology repository the owner
  of Proofbound Story, Authority job, planned steps, gate evaluation, or receipt
  semantics.

## Superpowers Reference Policy

`obra/superpowers` is a useful methodology reference, not a Proofbound runtime
dependency and not an authority source.

Reference repository:

```text
https://github.com/obra/superpowers
```

License note: the repository is MIT licensed. Proofbound may learn from the
methodology, but copied text or code must preserve the required license notice.

Reference principles Proofbound should absorb:

- clarify the user's intent before writing code;
- turn rough ideas into a written spec;
- write implementation plans as bite-sized tasks;
- avoid placeholders and vague "implement later" instructions;
- require concrete file paths, commands, and expected verification results;
- prefer TDD and verification-first development;
- isolate subagent tasks;
- review for spec compliance before code quality;
- keep evidence stronger than prose claims.

Lattice-specific constraints that override the reference:

- Proofbound Story is created only through Proofbound commands;
- verification intent is a Proofbound process fact, not prose-only planning text;
- Authority jobs are issued by Proofbound Authority;
- `plannedSteps[]` use Proofbound's typed step schema;
- provider execution is performed by the Stage B executor;
- DONE is gated only by verified native Proofbound Authority `gate_decision`
  receipts;
- external skill/plugin docs may guide prompting, but they do not control
  lifecycle, job leases, evidence, or receipt authority.

## Naming And Environment Contract

Canonical Proofbound CLI client names:

```text
LATTICE_AUTHORITY_URL
LATTICE_AUTHORITY_MODE
LATTICE_AUTHORITY_ACTOR_ID
LATTICE_AUTHORITY_ACTOR_ROLE
LATTICE_AUTHORITY_ACTOR_KEY
LATTICE_AUTHORITY_ACTOR_KEY_PATH
LATTICE_AUTHORITY_ACTOR_KEY_ENCODING
LATTICE_AUTHORITY_ACTOR_KEY_ID
LATTICE_AUTHORITY_CUSTOMER_API_KEY
LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH
LATTICE_AUTHORITY_KEY_FILE
LATTICE_AUTHORITY_RUNNER_ID
LATTICE_AUTHORITY_SESSION_ID
LATTICE_AUTHORITY_PROJECT_ID
LATTICE_AUTHORITY_SERVER_PUBLIC_KEY
LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING
LATTICE_AUTHORITY_SERVER_KEY_ID
LATTICE_AUTHORITY_BOOTSTRAP_TOKEN
LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS
LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS
```

Legacy `LATTICE_AUTHORITY_*` client variables remain aliases for compatibility.
When both names are present, `LATTICE_AUTHORITY_*` wins.

Canonical Proofbound Authority server names:

```text
LATTICE_AUTHORITY_ENV
LATTICE_AUTHORITY_DATABASE_URL
LATTICE_AUTHORITY_SERVER_KEY_ID
LATTICE_AUTHORITY_SERVER_PRIVATE_KEY_HEX
LATTICE_AUTHORITY_BOOTSTRAP_TOKEN
LATTICE_AUTHORITY_EVIDENCE_*
LATTICE_AUTHORITY_POLICY_*
LATTICE_AUTHORITY_COMMAND_INVENTORY_PATH
LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS
LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS
```

Legacy `CORD_TEAM_*` server variables remain aliases for compatibility. When
both names are present, `LATTICE_AUTHORITY_*` wins.

Mode mapping:

| User or diagnostic mode | Authority transport mode |
| --- | --- |
| `local` / `non-authority` | `off` |
| `shadow` diagnostic | `shadow` |
| `authority` | `enforce` |

`LATTICE_AUTHORITY_MODE` accepts exactly `off`, `shadow`, and `enforce`. It does
not accept autopilot mode names such as `local` or `authority`.

Authority URL and key-file defaults:

```text
defaultAuthorityUrl = http://localhost:6789/
defaultAuthorityKeyFile = .lattice/authority.md
```

Rules:

- the default Authority URL applies only when the user selects `authority` mode
  and does not provide `LATTICE_AUTHORITY_URL`;
- `local` / `non-authority` mode must not connect to the default server;
- production enforce-mode verification must not silently fall back to localhost;
- production enforce-mode verification requires HTTPS or trusted local tunnel and
  pinned server key material;
- `LATTICE_AUTHORITY_KEY_FILE` overrides the default key-file path when present;
- explicit CLI arguments or `LATTICE_AUTHORITY_*` environment variables override
  values read from `authority.md`;
- `authority.md` may supply local/test actor and server verification material,
  but its contents must never be uploaded as evidence or copied into provider
  prompts.

Minimal `.lattice/authority.md` machine-readable block:

```text
serverUrl: http://localhost:6789/
projectId: project-live-1
serverKeyId: local-test-server-key
serverPublicKeyEncoding: hex | base64
serverPublicKey: <public-key>
customerApiKeyPath: <local-customer-api-key-path>
actorId: local-test-actor
actorRole: runner
actorKeyId: local-test-actor-key
actorKeyEncoding: hex | base64
actorKeyPath: <local-private-key-path>
runnerId: local-test-runner
sessionId: local-test-session
testKeyProfile: local-test | none
```

Rules:

- `authority.md` is an internal key-management file for Proofbound Authority tests
  and local development;
- if `actorKeyPath` is present, the private key is read from that local path;
- raw production private keys must not be committed to `authority.md`;
- `authority.md` must be gitignored or otherwise excluded from commits when it
  contains private key material;
- a bundled default test key or `testKeyProfile=local-test` is valid only for
  deterministic tests and localhost development;
- default test keys must be rejected for deployed production Authority DONE and
  must not be accepted as pinned production server keys.

`LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS` controls client-side freshness checks for
native `gate_decision` receipts. Enforce-mode deployed verification defaults to
`600000` milliseconds. A value of `0` may disable freshness only for local
diagnostics. In enforce-mode production authority checks, an explicit `0` is
rejected rather than silently replaced.

`LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS` controls tolerated future clock skew
for receipt verification. Enforce-mode deployed verification defaults to
`300000` milliseconds. In enforce-mode production checks, a missing value uses
the default, but a negative value or a value above local policy is rejected.

## Authority Trust Model

Proofbound Authority is the only source of production authority for this track.

Trust rules:

- non-authority mode never connects to Proofbound Authority;
- local development may trust a discovered server key from localhost;
- deployed verification must use HTTPS or a trusted local tunnel;
- production verification must support pinned server public key and key id;
- a pinned key mismatch is a hard failure;
- bundled default test keys and `authority.md` local-test profiles are
  production-inert and must not satisfy production Authority DONE;
- `gate_decision` receipts must be verified with Ed25519 over the exact native
  canonical payload;
- authority status, policy discovery, runner readiness, live heartbeat, and
  jobs-available stream hints are not evidence of approval; `jobs.available` is
  only a streaming hint before the same signed POST claim/status contract.

## Native Signing Contract

Python implementation models may use `snake_case` internally. Public API JSON,
stored receipt JSON, and signed payloads use `camelCase` aliases.

Proofbound must sign and verify the public wire payload:

- sorted canonical JSON keys;
- compact separators;
- UTF-8 bytes;
- enum values as strings;
- omitted `None` / `null` values;
- `signature` excluded from signed bytes;
- UTC timestamps formatted in the Python/Pydantic canonical form with six
  fractional digits and `Z`, for example
  `2026-06-05T12:34:56.123000Z`.

Raw Ed25519 keys are byte-compatible across Python and TypeScript. String
encodings are not. Proofbound must normalize keys internally to bytes and accept
hex or base64 only when the encoding is explicit.

## Native Receipt Contract

Authority-backed DONE requires a native Proofbound Authority receipt:

```text
receiptId
kind
projectId
storyId
actorId
role
commandId
stateVersion
policyVersion
inputDigest
decisionDigest
issuedAt
serverKeyId
signature
```

For `lattice autopilot execute --mode=authority --until=DONE`, the receipt must:

- have `kind = gate_decision`;
- have the expected `projectId`;
- have the expected `storyId`;
- have the expected `serverKeyId`;
- include `decisionDigest`;
- match the expected `decisionDigest` when one is provided;
- verify with the configured or discovered server public key;
- pass freshness checks when freshness is enabled.

Freshness semantics:

- if `LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS` is unset in enforce mode, use the
  default `600000`;
- if `issuedAt` is older than the configured max age, verification fails with a
  stale receipt reason;
- if `issuedAt` is in the future by more than the configured clock-skew
  tolerance, verification fails with a future-dated receipt reason;
- local and shadow diagnostics may report stale receipts as warnings, but
  authority DONE must fail closed;
- server and client clocks must be recorded in verification output when a
  receipt freshness check fails.

Legacy receipts with `subjectId`, `subjectKind`, or `authorityActorId` may remain
supported for old compatibility tests, but they must not satisfy native Proofbound
Authority DONE.

## Command Surface

The implementation should extend existing Proofbound commands rather than create a
parallel product surface.

Required operator commands:

```bash
lattice authority status --json
lattice authority enforce policy --json
lattice authority enforce runner --dry-run --json
lattice authority enforce runner --live --once --json
lattice authority job status --jobId=<job> --json
lattice authority verdict submit --jobId=<job> --runId=<run> --verdictFile=<verdict.json> --json
lattice authority verdict list --jobId=<job> --json
lattice authority receipt verify --receiptFile=<receipt.json> --json
lattice story resolve --storyId=<story> --json
lattice autopilot status --json
lattice autopilot doctor --json
lattice autopilot run --mode=local --storyId=<story> --until=TEST --json
lattice autopilot run --mode=local --storyId=<story> --until=DONE --requireMultiHost --json
lattice autopilot execute --mode=local --storyId=<story> --until=TEST --json
lattice autopilot execute --mode=local --storyId=<story> --until=DONE --requireMultiHost --json
lattice autopilot run --mode=shadow --storyId=<story> --until=TEST --json
lattice autopilot execute --mode=authority --storyId=<story> --until=DONE --json
lattice autopilot review submit --storyId=<story> --runId=<run> --verdictFile=<verdict.json> --json
lattice autopilot review status --storyId=<story> --runId=<run> --json
```

The authority executor may add explicit runner options, but the user-facing path
should remain under `lattice autopilot execute --mode=authority`.

Status commands must be read-only and must report enough information for an
operator or second host to understand whether a run is planning, executing,
waiting for a decision, blocked, receipt-verified, or fully DONE.

`lattice authority verdict submit` is the server-backed Authority path.
`lattice autopilot review submit` is the local non-authority path. The local path
records verifier verdicts in Proofbound local run state keyed by `storyId` and
local `runId`; it must never create an Authority receipt or set Authority DONE
flags.

## Stage A Requirements: Authority Control Plane And Receipts

### A1. Policy And Server Key Discovery

`GET /v1/authority/policy` must expose:

```json
{
  "contractVersion": "authority-policy.v1",
  "serverKey": {
    "keyId": "server-key-id",
    "algorithm": "ed25519",
    "encoding": "hex",
    "publicKeyHex": "raw-public-key-hex"
  }
}
```

Proofbound CLI must parse this as metadata only. Policy discovery must not write
evidence, pass gates, claim DONE, or mutate local story lifecycle state.

### A2. Actor Key Bootstrap

Development mode may allow direct actor public key registration.

Production mode must require a customer-scoped API key and project scope for
actor enrollment. Servers may additionally require a bootstrap or admin
registration token, but that token is a registration control only and must not
replace customer/project authorization.

```text
Authorization: Bearer <LATTICE_AUTHORITY_CUSTOMER_API_KEY>
LATTICE_AUTHORITY_BOOTSTRAP_TOKEN
```

Rules:

- the customer API key authorizes the tenant/workspace/project for actor key
  registration;
- the bootstrap token, when server policy requires it, authorizes actor key
  registration only;
- the token is sent in an HTTP header, not inside signed actor payloads;
- the token does not sign receipts and does not grant gate approval;
- missing, wrong, revoked, expired, or wrong-project customer API key fails in
  production;
- missing, wrong, or empty bootstrap token fails in production when server policy
  requires bootstrap enrollment;
- registered keys must bind actor id, role, key id, runner id, status, and
  optional validity windows.

### A3. Live Runner Control Plane

`lattice authority enforce runner --live --once --json` must:

- derive `publicKeyHex` from the actor private key;
- register the actor key when needed;
- register the runner;
- heartbeat the runner;
- claim at most one job;
- release a claimed job immediately when provider execution is disabled;
- report `spawned=false` and no provider events in control-plane-only mode;
- never write local lifecycle gate evidence.

When provider execution is disabled, the release reason must be:

```text
control-plane-smoke-no-provider-execution
```

### A4. Receipt Verification

`lattice authority receipt verify` must:

- parse native Proofbound Authority receipt JSON;
- verify signature and binding fields;
- fail for tamper, wrong project, wrong story, wrong kind, wrong key id, wrong
  public key, missing `decisionDigest`, and stale receipt when freshness is
  enabled;
- classify the result as receipt verification only, not production DONE by
  itself.

### A5. Stage A Exit Criteria

Stage A is complete when:

- Proofbound discovers server key metadata;
- cross-language signing fixtures pass;
- actor key registration is secure in production;
- live runner register / heartbeat / claim / release works;
- a real signed `gate_decision` receipt can be produced by Proofbound Authority and
  verified by Proofbound;
- no status, readiness, policy, heartbeat, or claim path overclaims
  `productionDone`.

## Stage B Requirements: Authority-Backed Unattended Executor

### B1. Job Dispatch Contract

Proofbound Authority must be able to dispatch jobs that the Proofbound runner can
execute without ambiguity.

Each job must include:

```text
jobId
projectId
storyId
sessionId
runnerId or runnerCapability selector
authorityMode
targetPhase
until
plannedSteps[]
lease
retryPolicy
stopPolicy
providerPolicy
evidencePolicy
receiptPolicy
worktreePolicy
multiHostPolicy
createdAt
```

`plannedSteps[]` must be typed. Supported initial step types:

| Step type | Meaning |
| --- | --- |
| `lattice.command` | Run an argv-mapped allowlisted Proofbound command. |
| `provider.codex` | Run a bounded Codex CLI provider action. |
| `provider.claude` | Run a bounded Claude Code CLI provider action when explicitly enabled. |
| `provider.fake` | Run a deterministic fake provider action for fixtures only. |
| `validate.run` | Run configured validation. |
| `codex.verify` | Run `lattice codex verify` when adapter evidence is needed. |
| `gate.evaluate` | Ask Proofbound Authority to issue a gate decision. |
| `story.advance` | Advance lifecycle only through Proofbound CLI gate commands. |
| `stop.summary` | Stop and upload a final summary. |

All command-like steps must be represented as argv arrays or structured provider
requests. Shell strings are rejected unless a step explicitly declares a narrow
allowlisted shell escape and the local policy allows that exact escape.

Minimal `lease` shape:

```text
leaseId
leasedByRunnerId
leasedBySessionId
leaseExpiresAt
leaseTtlMs
renewalThresholdMs
graceMs
leaseVersion
```

Rules:

- `leaseId`, `leasedByRunnerId`, `leasedBySessionId`, and `leaseExpiresAt` are
  required on claimed jobs;
- the executor must renew before `renewalThresholdMs`;
- `graceMs` is diagnostic only and must not be used to claim DONE after the
  lease is unsafe;
- `leaseVersion` increments on renewal so stale completion attempts fail closed.

Minimal `retryPolicy` shape:

```text
maxAttemptsPerStep
maxRepairAttempts
maxNoProgressIterations
retryableFailureKinds[]
repairAllowed
```

Minimal `stopPolicy` shape:

```text
maxSteps
maxWallClockMs
onValidationFailure
onProviderFailure
onGateFailure
onReceiptFailure
onDirtyWorktree
onLeaseUnsafe
onMultiHostDisagreement
```

Minimal `evidencePolicy` shape:

```text
requiredEvidenceKinds[]
redactionRequired
retentionClassByKind
allowContinueWithoutEvidence
checklistCoverageRequired
```

Minimal `receiptPolicy` shape:

```text
requiredKind = gate_decision
expectedDecisionDigest
freshnessMaxAgeMs
clockSkewToleranceMs
requiredServerKeyId
```

Minimal `providerPolicy` shape:

```text
primaryProvider
allowedProviders[]
fallbackProviders[]
productionDoneProviders[]
allowFakeProviderForProductionDone
credentialsEnvAllowlist[]
secretRefs[]
providerAvailability = fail_closed
```

Rules:

- `allowFakeProviderForProductionDone` defaults to `false`;
- production authority DONE requires a provider listed in
  `productionDoneProviders[]`;
- fallback is allowed only from `primaryProvider` to a provider listed in
  `fallbackProviders[]`;
- credentials may be referenced by allowed environment names or opaque
  `secretRefs[]`, but job payloads must never include secret values.

Minimal `worktreePolicy` shape:

```text
resolver = lattice.story.resolve
requiresAuthoritativeWorktree
allowWorktreeRepair
allowedPathRoots[]
forbiddenPathGlobs[]
requiresCleanWorktree
preserveUnrelatedDirtyChanges
requireGitStatusEvidence
```

Rules:

- `requiresAuthoritativeWorktree` defaults to `true` for authority mode;
- `preserveUnrelatedDirtyChanges` defaults to `true`;
- `requireGitStatusEvidence` defaults to `true` for mutating steps.

Minimal `multiHostPolicy` shape:

```text
mode = off | local_review | authority_full_done
minIndependentHosts = 2
requiredHostVerdictCount
targetHostsPerWave = 2-3
preferredHostsForReleaseCertification = 3+
preferredVerifierProviders[]
requiredVerifierProviders[]
maxReviewWaves
reviewPromptProfile
fullAuthorityDoneRequired
localReviewRequired
disagreementBehavior = block | repair_then_reverify
```

Rules:

- `minIndependentHosts` defaults to `2`;
- `targetHostsPerWave` should normally be `2-3`;
- release certification may prefer `3+` independent hosts, including Gemini
  when registered and available, but preferred hosts do not block unless policy
  also marks them required;
- Gemini is a verifier host by default, not a new `plannedSteps[]` provider
  type;
- `maxReviewWaves` must be finite so repair and re-review cannot loop forever;
- `fullAuthorityDoneRequired` controls whether the run waits for the Authority
  multi-host final gate after per-run `authorityDone`;
- `localReviewRequired` controls whether local non-authority DONE waits for the
  local certified review gate;
- no `verdict.*` planned step type is introduced; host verdict submit/list is a
  final certification command/API phase.

### B2. Worktree And Scope Safety

Authority mode must operate inside the story's authoritative Proofbound worktree.

Rules:

- use the read-only `lattice story resolve --storyId=<story> --json` contract to
  identify the authoritative cwd; until that command exists, the implementation
  must use the same internal resolver that powers `lattice story_get --detail`
  and `lattice story_advance --phase=INIT_CHECK`;
- create or repair a story worktree only through Proofbound commands;
- initial worktree creation must go through `lattice story_advance
  --storyId=<story> --phase=INIT_CHECK`;
- refuse to edit outside the configured project/worktree boundary;
- never directly edit `.lattice/story`, `.lattice/story`, `docs/story`, or test
  fixture JSON;
- preserve unrelated dirty user changes;
- capture git status before and after each mutating step;
- stop before merge or remote push unless the Proofbound lifecycle gate authorizes
  it.

### B3. Provider Executor

The provider executor must support bounded development, not open-ended chat.

Initial providers:

- Codex CLI;
- Claude Code CLI when explicitly enabled.

Provider requirements:

- run with timeout;
- run with max attempts;
- run with explicit cwd;
- capture stdout, stderr, exit code, duration, and model/provider metadata;
- upload provider events to Proofbound Authority;
- never treat provider success as validation success;
- never treat provider output prose as gate evidence without structured
  evidence or a verified receipt.

The first provider executor may support a safe fake provider for deterministic
tests before enabling real Codex or Claude execution.

### B3a. Provider Availability And Fallback

Provider availability is a preflight requirement, not a runtime surprise.

Rules:

- missing provider CLI, missing login, unavailable model, unsupported runtime, or
  local policy rejection must fail closed before the step starts;
- a provider may be replaced only when the Authority job's `providerPolicy`
  explicitly allows the fallback provider;
- every fallback must record the requested provider, selected provider, reason,
  policy rule, and provider metadata in evidence;
- `provider.fake` may be used for deterministic fixtures and tests, but it must
  not silently replace Codex or Claude in a production authority-DONE run;
- if no permitted provider is available, the executor stops blocked with a
  `provider_unavailable` reason and releases the lease cleanly;
- provider fallback does not weaken validation, evidence, receipt, or multi-host
  final verification requirements.

### B3b. Provider Credential Management

Provider credentials must be available without exposing secrets to the planner,
job payload, provider transcript, or evidence records.

Rules:

- provider credentials may come only from local environment variables named in
  `providerPolicy.credentialsEnvAllowlist[]` or from configured
  `providerPolicy.secretRefs[]`;
- the executor may pass approved credentials to the provider process only through
  the provider's normal local authentication mechanism or a redacted
  environment projection;
- credentials must not be copied into planned steps, prompts, evidence, final
  summaries, or Authority job metadata;
- if a required credential is missing, the run stops blocked with
  `credential_unavailable`;
- unattended mode must not ask the user to paste a secret during execution.

### B4. Evidence Upload

Every executor loop must upload structured evidence to Proofbound Authority:

| Evidence | Required fields |
| --- | --- |
| run record | run id, job id, runner id, project id, story id, start/end times. |
| provider event | provider, model, argv/request digest, exit code, stdout/stderr digest, duration. |
| command event | command name, argv digest, cwd, exit code, output digest, material hash. |
| validation evidence | command list, pass/fail, failure reason, relevant artifacts. |
| git evidence | before/after status, changed file list, commit id when committed. |
| gate request | input digest, policy version, state version, requested target. |
| stop summary | final status, attempts, failures, next action. |

Evidence upload acceptance is not enough for DONE. DONE requires a verified
`gate_decision` receipt.

### B4a. Evidence Redaction, Privacy, And Retention

Evidence must be useful for verification without leaking secrets.

Rules:

- stdout, stderr, provider prompts, provider responses, command output, diffs,
  environment references, and uploaded artifacts must pass through configured
  redaction before upload;
- access tokens, private keys, session cookies, Authorization headers, password
  values, and raw environment variables must never be uploaded as evidence;
- evidence records should prefer digests, material hashes, command argv digests,
  redacted excerpts, and artifact refs over raw logs;
- if redaction changes material evidence, the record must include a
  `redactionSummary` and the digest of the unredacted local artifact when local
  policy allows keeping it;
- retention policy must be explicit for run records, provider events, command
  events, validation evidence, git evidence, and final summaries;
- a run that needs credentials not configured in policy stops blocked instead
  of asking an unattended executor to invent or expose secrets.

### B4b. Evidence Storage And Lifecycle

Evidence storage must support later verification without becoming an unbounded
log dump.

Rules:

- Proofbound Authority stores evidence metadata, digests, redaction summaries, and
  artifact refs in durable storage;
- large raw artifacts may live in configured artifact storage, but the Authority
  record must retain their digest, size, media type, redaction state, and
  retention class;
- retention classes must include at least `short_lived_run_log`,
  `verification_artifact`, `receipt_bound_artifact`, and `final_summary`;
- artifacts referenced by a passing `gate_decision` receipt must not be garbage
  collected before the configured receipt-bound retention window expires;
- failed or blocked runs may use shorter retention, but final blocked summaries
  and decision reasons remain queryable;
- garbage collection must delete only artifacts whose retention class and expiry
  allow deletion, and must not delete receipt JSON or final host verdict records.

### B5. Retry, Repair, And Stop Policy

Authority mode must be bounded by explicit retry and stop policies:

```text
maxAttemptsPerStep
maxRepairAttempts
maxNoProgressIterations
retryableFailureKinds[]
repairAllowed
maxSteps
maxWallClockMs
onValidationFailure
onProviderFailure
onGateFailure
onDirtyWorktree
onReceiptFailure
onLeaseUnsafe
onMultiHostDisagreement
```

The first group belongs to `retryPolicy`; the limit and stop-behavior fields
belong to `stopPolicy`. A job that mixes the fields ambiguously fails schema
validation before execution.

Required behavior:

- retry provider failures according to policy;
- run repair steps only when explicitly configured;
- return to DEV after validation failure when the lifecycle says so;
- stop with `blocked` after repeated identical blockers;
- release the job lease on stop;
- upload final summary and evidence;
- never continue silently after receipt verification failure.

### B6. Gate Evaluation And DONE Receipt

Authority mode must use Proofbound Authority to decide production DONE.

Flow:

1. Build gate input from canonical story state, evidence refs, validation result,
   process events, material hash, and requested target.
2. Submit `POST /v1/gates/evaluate`.
3. Receive or fetch a native `gate_decision` receipt.
4. Verify receipt signature and bindings in Proofbound.
5. Only then allow authority DONE projection.

Local Proofbound DONE and production DONE remain separate concepts unless the
verified receipt explicitly binds the story and decision digest.

### B7. Executor Loop

`lattice autopilot execute --mode=authority` must implement a loop:

```text
discover policy
verify authority readiness
register / heartbeat runner
claim job
lock story/worktree scope
execute planned step
upload evidence
renew heartbeat / lease
validate when required
repair or retry when policy allows
request gate evaluation
verify receipt
submit implementer verdict when required
wait or poll for independent verifier verdict when required
reconcile multi-host verdicts
advance or stop
release job
write final summary
```

The loop must support `--once` for one job and bounded `--until=TEST|DONE` for a
story target.

### B8. Executor Runtime State

The executor loop must maintain explicit runtime state. It cannot infer progress
from prose output.

Required local runtime state:

```text
executorRunId
jobId
projectId
storyId
sessionId
runnerId
authorityRunId
currentStepIndex
currentStepAttempt
targetPhase
until
startedAt
lastHeartbeatAt
lastLeaseRenewalAt
lastMaterialHash
lastValidationDigest
lastGateInputDigest
lastReceiptId
currentReviewWaveId
lastReviewPromptDigest
lastHostVerdictRefs[]
localReviewCertified
multiHostStatus
status
stopReason
```

Valid `status` values:

```text
initializing
ready
claimed
executing_step
uploading_evidence
validating
repairing
requesting_gate
verifying_receipt
advancing
completed
blocked
failed
released
```

The state must be persisted or emitted often enough that an interrupted run can
be diagnosed. A future resumable implementation may reuse this state to continue
from the last completed step, but the first implementation may choose fail-safe
restart if it releases any active lease before exiting.

### B9. Executor Inputs

Authority executor inputs come from three places.

CLI arguments:

```text
--mode=authority
--storyId
--until=TEST|DONE
--once
--maxSteps
--maxAttempts
--maxWallClockMs
--provider=codex|claude|fake
--allowClaudeProvider
--requireMultiHost
--requiredHostVerdictCount
--maxReviewWaves
--json
```

This `--provider` is the bounded planner/executor step provider, whose local
executor support remains intentionally closed. It is distinct from
`LATTICE_AUTHORITY_RUNNER_PROVIDER` and `authority_job_create --provider`, which
are Authority provider declarations propagated to the server for policy
evaluation.

Environment:

```text
LATTICE_AUTHORITY_URL
LATTICE_AUTHORITY_ACTOR_ID
LATTICE_AUTHORITY_ACTOR_ROLE
LATTICE_AUTHORITY_ACTOR_KEY
LATTICE_AUTHORITY_ACTOR_KEY_PATH
LATTICE_AUTHORITY_ACTOR_KEY_ENCODING
LATTICE_AUTHORITY_ACTOR_KEY_ID
LATTICE_AUTHORITY_CUSTOMER_API_KEY
LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH
LATTICE_AUTHORITY_KEY_FILE
LATTICE_AUTHORITY_GATE_ACTOR_ID
LATTICE_AUTHORITY_GATE_ACTOR_ROLE
LATTICE_AUTHORITY_GATE_ACTOR_KEY
LATTICE_AUTHORITY_GATE_ACTOR_KEY_PATH
LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING
LATTICE_AUTHORITY_RUNNER_ID
LATTICE_AUTHORITY_SESSION_ID
LATTICE_AUTHORITY_PROJECT_ID
LATTICE_AUTHORITY_SERVER_PUBLIC_KEY
LATTICE_AUTHORITY_SERVER_KEY_ID
LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS
LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS
LATTICE_AUTHORITY_HEAD_HASH
LATTICE_AUTHORITY_MATERIAL_HASH
LATTICE_AUTHORITY_COMMAND_CATALOG_DIGEST
LATTICE_AUTHORITY_EVIDENCE_SCHEMA_DIGEST
```

Authority job payload:

```text
plannedSteps[]
retryPolicy
stopPolicy
evidencePolicy
receiptPolicy
worktreePolicy
providerPolicy
multiHostPolicy
lease
```

Precedence rules:

- CLI safety limits may only reduce authority job limits, never expand them.
- Local policy may reject a provider or shell capability even if the job asks for
  it.
- The job `projectId`, `storyId`, and target must match CLI arguments when the
  CLI provides them.
- A mismatch between CLI arguments and authority job identity is a hard failure.
- `--requireMultiHost`, `--requiredHostVerdictCount`, and `--maxReviewWaves` may
  only make local policy stricter than the job policy. They may not weaken a
  server-required `multiHostPolicy`.

### B10. Planned Step Contract

Each planned step must have a stable machine-readable shape:

```json
{
  "stepId": "step-001",
  "type": "provider.codex",
  "title": "Implement the checklist item",
  "purpose": "satisfy checklist item CHK-001 with bounded provider work",
  "cwdPolicy": "story-worktree",
  "timeoutMs": 600000,
  "maxAttempts": 2,
  "requiresCleanWorktree": false,
  "producesEvidence": true,
  "blocksUntilEvidenceUploaded": true,
  "provider": "codex",
  "validationBinding": {"stepId": "step-002"},
  "repairBinding": {"stepId": "step-003"},
  "evidenceBinding": {"checklistItemIds": ["CHK-001"]},
  "args": {}
}
```

Common fields:

| Field | Requirement |
| --- | --- |
| `stepId` | Stable id used for idempotency and evidence refs. |
| `type` | One of the allowlisted step types. |
| `title` | Human-readable label, not a decision source. |
| `cwdPolicy` | Usually `story-worktree`; `project-root` only for read-only checks. |
| `timeoutMs` | Required for provider and validation steps. |
| `maxAttempts` | Must not exceed job or CLI safety limits. |
| `requiresCleanWorktree` | If true, executor checks git status before running. |
| `producesEvidence` | If true, evidence upload is required before the step is complete. |
| `blocksUntilEvidenceUploaded` | If true, failed evidence upload fails the step. |
| `provider` | Required for provider steps; omitted for non-provider steps. |
| `purpose` | Machine-readable reason tied to checklist, validation, repair, gate, or summary work. |
| `validationBinding` | Optional binding to validation step ids or validation evidence refs. |
| `repairBinding` | Optional binding to repair step ids or repair policy. |
| `evidenceBinding` | Optional binding to checklist items, evidence kinds, artifact refs, or gate predicates. |
| `args` | Type-specific structured arguments. |

No step may rely on free-form natural language as the only executable payload.
Provider prompts may contain natural language, but the step type, cwd, timeout,
attempt count, provider selection, evidence requirements, repair behavior, and
validation behavior must be structured.

### B11. Step Execution Lifecycle

Every step follows the same lifecycle:

```text
preflight
start step event
execute
capture output
compute digests
upload evidence
classify result
decide next action
```

Preflight checks:

- authority mode is still `enforce`;
- lease is valid or renewed;
- heartbeat succeeds or is within grace period;
- story cwd is authoritative;
- job identity still matches project/story/session;
- local policy allows the step type;
- required provider is available;
- required clean worktree condition is satisfied;
- max step count and max wall clock are not exceeded.

Captured output:

- stdout and stderr digests;
- optional truncated previews for diagnostics;
- exit code;
- start and end timestamps;
- duration;
- cwd;
- argv or structured provider request digest;
- before/after git status;
- before/after material hash when available.

Result classification:

```text
success
retryable_failure
validation_failure
policy_failure
receipt_failure
no_progress
blocked
fatal
```

The executor may continue only after a result classification has been recorded
and evidence upload has succeeded or the job policy explicitly allows continuing
without that evidence.

### B12. Heartbeat, Lease, And Idempotency

The executor must keep the authority job lease healthy while running.

Rules:

- heartbeat before claim, after claim, before long provider execution, after
  provider execution, before gate evaluation, and before release/completion;
- renew lease before it crosses the configured renewal threshold;
- release the job on local stop, blocked stop, policy failure, or receipt
  failure;
- complete the job only after final evidence and receipt checks pass;
- never leave a claimed job leased after a no-provider smoke path;
- use `evidenceIdempotencyKey` from X5 when uploading evidence;
- duplicate upload of the same idempotency key must not create conflicting
  authority records;
- if completion is retried after a network failure, the server must treat it as
  idempotent when the job result digest matches.

### B13. Provider Execution Protocol

Provider steps are execution hosts, not authority.

`provider.codex` must:

- run Codex non-interactively;
- use the authoritative story worktree cwd;
- receive a bounded instruction derived from the planned step;
- obey timeout and attempt limits;
- emit provider metadata and output digests;
- never call `git reset --hard`, destructive checkout, remote push, or direct
  story JSON edits unless a later explicit policy allows it.

`provider.claude` must:

- be disabled unless explicitly enabled by CLI and local policy;
- use the same bounded step contract as Codex;
- capture timeout, exit code, and output digests;
- produce evidence with provider name `claude`;
- fail closed if Claude CLI hangs past timeout.

`provider.fake` must:

- be available for deterministic E2E tests;
- simulate success, validation failure, timeout, and blocked cases;
- never modify files unless the fixture explicitly asks for a safe test change.

Provider completion does not imply step success until Proofbound captures output,
uploads evidence, and runs any required validation step.

### B14. Validation And Repair Loop

Validation is an explicit step, not a provider side effect.

The canonical validation command is:

```bash
lattice validate --story=<story> --json
```

For broader release or deployment checks, the planned step may explicitly use
`lattice validate --full --story=<story> --json`. Custom validation commands
must be allowlisted in the Authority job and linked to checklist evidence.

Validation flow:

1. Run the configured Proofbound validation command or allowlisted validation step.
2. Upload validation evidence.
3. If validation passes, continue toward gate evaluation or next step.
4. If validation fails, classify the failure.
5. If repair is allowed and attempts remain, enqueue or run the configured
   repair provider step.
6. If repair is not allowed or attempts are exhausted, stop with `blocked`.

Repair rules:

- repair steps must be planned or generated from a structured failure summary;
- repair attempts are counted separately from provider execution attempts;
- identical validation failure digests increment `noProgress` counters;
- repeated identical failures stop according to `maxNoProgressIterations`;
- repair cannot bypass validation;
- repair cannot satisfy DONE without gate receipt verification.
- if repair changes artifacts, evidence, material hash, local lifecycle state, or
  planned-step outputs, prior gate inputs, receipts, and host verdicts become
  stale for final certification.

### B15. Gate Evaluation Protocol

Gate evaluation is the bridge from local work to production authority.

Gate input must include:

```text
projectId
storyId
targetPhase
until
canonicalStoryDigest
materialHash
validationDigest
evidenceRefs[]
providerEventRefs[]
commandEventRefs[]
gitEvidenceRefs[]
policyVersion
stateVersion
requestedByRunnerId
jobId
authorityRunId
```

Gate flow:

1. Build gate input.
2. Compute `gateInputDigest`.
3. Submit `POST /v1/gates/evaluate`.
4. Receive `decision`, `decisionDigest`, and `receiptId` or embedded receipt.
5. Fetch receipt when only `receiptId` is returned.
6. Verify native receipt signature and bindings.
7. Check `receipt.kind = gate_decision`.
8. Check receipt `decisionDigest` equals the returned or expected digest.
9. Record the verified receipt reference.
10. Advance or complete according to the decision.

Allowed `decision` values are `approve`, `reject`, and `blocked`.
Only `approve` may support per-run authority DONE projection.

Any failure from steps 5-8 is a receipt failure and must stop the authority DONE
path. It may not downgrade silently to local DONE.

### B16. Advancement And Completion

The executor may advance lifecycle only through Proofbound CLI commands.

Rules:

- `story.advance` steps call Proofbound command handlers through argv-mapped
  commands;
- TEST advancement requires local lifecycle gates to pass;
- DONE authority projection requires verified native `gate_decision` receipt;
- local DONE and authority DONE are reported separately;
- local non-authority certified completion is reported as `localReviewCertified`
  and must never set `authorityDone`, `fullAuthorityDone`, or
  `multiHostVerified`;
- per-run `authorityDone` means the run has a verified native gate receipt and
  satisfies local/Authority reconciliation for that run;
- `fullAuthorityDone` means per-run `authorityDone=true` plus the multi-host
  final verification gate has passed;
- if local lifecycle advances but authority receipt fails, final status is not
  authority DONE;
- final job completion includes all evidence refs, receipt refs, final phase,
  local done flag, per-run authority done flag, full authority done flag,
  multi-host verification state, and stop reason.

Final output JSON must include:

```text
jobId
storyId
projectId
status
localPhase
localDone
localReviewCertified
localHostVerdictCount
authorityDone
fullAuthorityDone
multiHostVerified
independentHostVerdictCount
requiredHostVerdictCount
hostVerdictRefs[]
multiHostStatus
reviewWaveId
reviewWaveRefs[]
receiptVerified
receiptFreshness
receiptId
decisionDigest
executedSteps[]
evidenceRefs[]
providerEvents[]
providerFallback
redactionSummary
validationResult
budgetUsage
timeline
plannerRefs[]
idempotencyRefs[]
forcedNewRun
stopReason
nextAction
```

### B17. Failure And Stop Semantics

The executor must distinguish failure types.

| Failure | Required behavior |
| --- | --- |
| authority readiness missing | fail closed before claim. |
| job identity mismatch | release job if claimed, stop `failed`. |
| provider timeout | retry when allowed, otherwise stop `blocked`. |
| validation failure | repair when allowed, otherwise stop `blocked`. |
| dirty unrelated worktree | stop unless policy explicitly allows proceeding. |
| evidence upload failure | retry upload; stop if required evidence cannot upload. |
| heartbeat failure | try grace-period renewal; stop/release if lease is unsafe. |
| gate rejection | stop `blocked` with decision summary. |
| receipt verification failure | stop `failed`; never claim authority DONE. |
| max wall clock exceeded | release job and stop `blocked`. |
| max no-progress exceeded | release job and stop `blocked`. |
| redevelopment adapter unavailable | stop `blocked` with `adapter_unavailable` before provider execution. |
| redevelopment source-only untranslatable behavior | record `gapList[]` or stop `blocked` with `source_only_untranslatable`; do not enqueue repair for that item. |

Every stop path must upload or attempt to upload a final stop summary. If the
authority server is unavailable, the CLI must print a local final summary and
mark it as not authority-backed.

### B18. Minimal Pseudocode

The first implementation should be structurally close to this loop:

```text
load settings
assert mode in local|shadow|authority
discover local and authority policy when relevant
if mode == authority:
  pin or verify server key
  load actor key
  register actor key if required
  register runner
  heartbeat runner
  claim job
  if no job: return success/no-job
  create authority run record
else:
  create local autopilot run record
resolve story worktree
for step in plannedSteps:
  enforce global limits
  heartbeat and renew lease if needed
  preflight step
  execute step
  capture output and digests
  upload evidence
  classify result
  if success: continue
  if retryable and attempts remain: retry step
  if validation_failure and repair allowed: run repair step then validate again
  stop blocked/failed when policy requires
if mode == authority and target requires gate:
  build gate input
  submit gate evaluation
  fetch receipt if needed
  verify native gate_decision receipt
  fail closed on receipt mismatch
  mark per-run authorityDone projection only
if local non-authority final review is requested:
  submit local implementer host verdict
  wait or poll for independent local verifier verdicts
  reconcile local multi-host verdicts
  if required verdicts fail or are missing: stop blocked
  mark localReviewCertified only after local multi-host pass
if full authority DONE is requested:
  submit implementer host verdict
  wait or poll for independent verifier verdicts
  reconcile multi-host verdicts
  if required verdicts fail or are missing: stop blocked
  mark fullAuthorityDone projection only after multi-host pass
advance local lifecycle only through Proofbound commands when allowed
complete or release job
write final summary
```

This pseudocode is normative for sequencing. Individual functions may be
refactored, but implementation must preserve the same safety boundaries.

### B19. Stage B Exit Criteria

Stage B is complete when:

- a queued authority job can drive a story from DEV toward TEST with real
  provider execution;
- validation failure triggers bounded repair or a clear blocked stop;
- passing validation uploads evidence and requests gate evaluation;
- DONE requires and verifies a native `gate_decision` receipt;
- job leases are released or completed correctly;
- final output includes a traceable summary bound to evidence refs, verdict refs,
  and receipt refs when receipts exist;
- executor state, step evidence, stop reason, and receipt verification result
  are visible in JSON output;
- local and shadow autopilot behavior remains unchanged.

## Stage C Requirements: Lattice-Native Planner

Stage C makes complete unattended development possible from a natural-language
request. It must generate the Story and Authority job inputs that Stage B needs.

Stage C must be Proofbound-native. It may borrow methodology from Superpowers, but
it must produce Proofbound process artifacts and use Proofbound commands.

### C1. Planner Command Surface

Required commands:

```bash
lattice planner draft --request="<one sentence or paragraph>" --interactionMode=autonomous --json
lattice planner draft --requestFile=requirements.md --interactionMode=interview --json
lattice planner review --draftFile=<draft.json> --json
lattice planner create-story --draftFile=<draft.json> --json
lattice planner create-job --storyId=<story> --json
lattice planner status --runId=<plannerRun> --json
lattice planner answer --runId=<plannerRun> --answersFile=<answers.json> --json
lattice planner decision submit --runId=<plannerRun> --decisionFile=<decisions.json> --json
lattice planner resume --runId=<plannerRun> --json
lattice planner source-manifest --sourceRepo=<path-or-ref> --includedPaths=<paths> --excludedPaths=<paths> --json
lattice planner run --request="<one sentence or paragraph>" --interactionMode=autonomous --mode=local --until=DONE --requireMultiHost --json
lattice planner run --request="<one sentence or paragraph>" --interactionMode=autonomous --mode=authority --until=DONE --json
lattice planner run --workflow=source-aligned-redevelopment --sourceRepo=<path-or-ref> --targetProject=<path> --targetProjectName=<name> --sourceLanguage=<source-language> --targetLanguage=<target-language> --interactionMode=autonomous --mode=local --until=DONE --json
lattice planner run --request="<one sentence or paragraph>" --forceNewRun --forceNewRunReason="<reason>" --mode=authority --until=DONE --json
lattice planner run --request="<one sentence or paragraph>" --interactionMode=decision-gated --mode=authority --until=DONE --json
lattice planner run --requestFile=requirements.md --interactionMode=interview --mode=authority --until=DONE --json
```

Command behavior:

- `planner draft` is read-only and produces a structured draft.
- `planner review` checks completeness, ambiguity, unsupported scope, and
  placeholder content.
- `planner create-story` mutates Proofbound Story state only through Proofbound
  commands.
- `planner create-job` submits signed Authority job creation requests in
  authority mode. In local mode, the planner emits a local execution plan with
  the same structured planned-step contract but no Authority job or receipt.
- signed Authority job creation requests must use the `jobCreateRequestEnvelope`
  shape from C3. Unsigned job creation is allowed only for local run plans and
  deterministic fixtures that explicitly mark `authorityMode=local`.
- `planner status` is read-only and reports request digest, mode, Story/job ids,
  current phase, required decisions, evidence refs, receipt refs, and final
  status when available.
- `planner answer` records structured interview answers for a paused planner
  run.
- `planner decision submit` records structured decisions for a paused
  `decision-gated` run.
- `planner resume` continues a paused run after required answers or decisions
  are recorded.
- `planner source-manifest` is read-only and extracts the deterministic
  `sourceManifestDigest` for source-aligned redevelopment intake (C2a) before any
  provider execution starts.
- `planner run` composes draft, review, story creation, job creation or local
  execution-plan creation, and the Stage B executor according to interaction
  mode and policy.
- `planner run --workflow=source-aligned-redevelopment` composes a
  source-aligned redevelopment workflow. Redevelopment is a development
  workflow, not a Planner Interaction Mode.

### C1a. Planner Interaction Modes

Users can choose one of three interaction modes at development time. The modes
change only the human participation policy. They do not change the selected
development mode. Authority mode still needs Story, Authority job, evidence,
gate receipt, and Authority DONE reconciliation. Local mode still needs Story,
local execution evidence, validation, and local review certification when
policy requires it.

| Mode | Input | Human participation | Allowed final result |
| --- | --- | --- | --- |
| `autonomous` | one sentence, paragraph, or request file | No user confirmation during the run. If risk or ambiguity becomes too high, use a bounded 2-3 host decision wave instead of asking the user. | selected-mode DONE or blocked |
| `interview` | one sentence or request document | Ask 5-10 sufficiently detailed questions, produce a reviewed draft/plan, require one confirmation, then run unattended. If mid-run risk or ambiguity becomes too high, use a bounded 2-3 host decision wave. | selected-mode DONE or blocked after confirmation |
| `decision-gated` | one sentence or paragraph | Proceed autonomously until a major decision appears; pause only for those decisions, then continue to DONE or blocked. | selected-mode DONE or blocked with decision receipts |

Mode rules:

- if `--interactionMode` is omitted, the default is `autonomous`;
- the selected mode, whether it was defaulted, and the policy version used for
  mode handling must be visible in planner JSON output;
- planner must not silently switch interaction modes after a run starts;
- `autonomous` may recommend rerunning as `interview` or `decision-gated`, but
  it must not ask the user mid-run or silently switch interaction modes;
- `autonomous` is the fastest path and may not ask follow-up questions. It must
  record assumptions for low-risk ambiguity;
- when `autonomous` encounters high-risk ambiguity or a major decision that can
  be resolved by policy and evidence, it must pause the executor, run a bounded
  2-3 host decision wave, record structured host decision evidence, and continue
  only if that wave resolves the issue;
- when `autonomous` host decision waves fail, disagree without repair, exceed
  budget, or encounter a decision that policy requires a human to make, the run
  stops blocked with exact next action;
- `interview` must generate between 5 and 10 concrete questions before creating
  the final Story/job plan. Questions must cover scope, success criteria,
  constraints, risk, validation, provider/tool preference, deployment boundary,
  and DONE semantics when relevant.
- `interview` must require user confirmation of the reviewed draft/plan before
  Story creation or Authority job creation.
- after the `interview` confirmation, unattended execution follows the same
  high-risk host decision wave rule as `autonomous` instead of repeatedly asking
  the user.
- `decision-gated` must identify major decisions and pause only when such a
  decision is reached. Routine implementation choices are handled by policy and
  evidence, not by asking the user.
- All user confirmations and major decisions must be recorded as structured
  planner evidence with stable ids and digests.

Major decision categories:

```text
scope expansion
destructive file or git operation
schema/API breaking change
database migration
deployment
credential or secret requirement
security/privacy tradeoff
cost increase
provider/model change outside policy
test strategy downgrade
DONE semantic change
receipt/gate/DONE semantics change
multiple possible product interpretations
```

If `decision-gated` reaches one of these categories, it must emit
`requiredDecisions[]` and pause. It may continue only after receiving structured
decision confirmation. If no confirmation is available, the run stops blocked.

### C1b. Question And Decision I/O

Planner interaction must be testable from the CLI and must not depend on an
unstructured chat transcript.

Question output for `interview`:

```text
plannerRunId
questions[]
questionId
questionText
reason
required = true | false
expectedAnswerShape
```

Answer input:

```bash
lattice planner answer --runId=<plannerRun> --answersFile=<answers.json> --json
```

`answers.json` must include:

```text
plannerRunId
answers[]
answerId
questionId
answerText
answeredBy
answeredAt
```

Decision input:

```bash
lattice planner decision submit --runId=<plannerRun> --decisionFile=<decisions.json> --json
```

`decisions.json` must include:

```text
plannerRunId
decisions[]
decisionId
category
selectedOption
reason
confirmedBy
confirmedAt
```

Rules:

- `planner answer` and `planner decision submit` record planner evidence with
  stable digests;
- `planner resume` may continue only after all required questions or decisions
  for the current pause point are satisfied;
- missing required answers or decisions persist the run as `paused` and the CLI
  process exits safely instead of waiting indefinitely in memory;
- `planner resume` rehydrates the paused run from persisted planner state;
- `autonomous` mode must not call these commands during a run;
- E2E tests must be able to drive `interview` and `decision-gated` without a
  live human by supplying answer/decision files.

### C2. Story Planner

Story Planner input:

```text
naturalLanguageRequest
requestSource = inline | file
requestFormat = one_sentence | paragraph | multi_paragraph
interactionMode = autonomous | interview | decision-gated
projectId
repoRoot
authorityMode
allowedScope
plannerPolicy
questionBudget
decisionPolicy
```

Input rules:

- `--request` accepts one sentence or one inline paragraph;
- `--requestFile` accepts longer paragraphs and multi-paragraph requirement
  text;
- both inputs are normalized into `naturalLanguageRequest`;
- the original text is hashed as `naturalLanguageDigest`;
- the planner must preserve materially important user wording in the draft
  evidence without using that wording as executable authority;
- long requests must be decomposed into one Story unless policy explicitly
  allows multi-Story planning.

Story Planner output:

```text
plannerDraftId
interactionMode
title
description
type
priority
background
checklist[]
verificationIntent[]
riskAssessment
questions[]
answersDigest
confirmationDigest
requiredDecisions[]
decisionReceipts[]
scopeQuestions[]
assumptions[]
rejectedInterpretations[]
relatedDocs[]
plannerDigest
```

The planner must generate:

- a concise title;
- a clear description;
- four-section background content when the current story flow requires it;
- checklist items with concrete context;
- verification intent for each checklist item;
- explicit assumptions;
- explicit out-of-scope items;
- risk classification;
- related docs selected from `lattice aux_doc_list`;
- a planner digest that binds the natural-language input and generated draft.

The Story Planner must not create a Story if:

- required fields are missing;
- checklist items are vague;
- verification intent is absent;
- scope is too broad for one Story;
- the request asks for destructive or unsafe behavior;
- the request cannot be mapped to the current repository.

When it does create a Story, it must call Proofbound commands such as
`story_create`, `story_draft`, `checklist_add`, or their current canonical
equivalents. It must not write story JSON directly.

### C2a. Source-Aligned Redevelopment Workflow

Source-Aligned Redevelopment Workflow is a strong source-aligned development
workflow. It is not a fourth Planner Interaction Mode. It runs under one of the
existing interaction modes (`autonomous`, `interview`, or `decision-gated`) and
under one selected development mode (`local` / `non-authority` or `authority`).
This is a required current-pass capability, not part of the already-available
baseline until its fixtures pass.

Goal:

```text
authorized source codebase
-> target project
-> declared source language and target language
-> source-aligned modules, functions, behavior, and fine details
-> allowed project-name-based identifier renaming
-> validated alignment evidence
-> selected-mode DONE or blocked
```

Required input:

```text
workflow = source-aligned-redevelopment
sourceRepoRef
sourceAccessAuthorization
targetProjectPath
targetProjectName
sourceLanguage
targetLanguage
renameMap
redevelopmentScope
includedPaths[]
excludedPaths[]
licenseHandling
secretHandling
languageAdapterPolicy
semanticMappingPolicy
parityOraclePolicy
alignmentVerificationIntent[]
sourceLimits
```

Rules:

- the user must provide or confirm authorization to use the source codebase;
- `sourceLanguage` and `targetLanguage` are canonical language ids such as
  `typescript`, `rust`, `swift`, `kotlin`, `python`, or `go`. The workflow must
  be language-pair agnostic; `typescript -> rust`, `typescript -> swift`,
  `swift -> kotlin`, `typescript -> python`, and `typescript -> go` are examples
  of the same contract, not separate special workflows;
- the source codebase is read-only input and must not be mutated by the
  executor;
- target project files are created or modified only through the Proofbound story
  worktree and normal lifecycle gates;
- variable, identifier, package, module, or project naming may be changed only
  according to an explicit `renameMap` or project-name-derived rule recorded in
  planner evidence;
- cross-language redevelopment may use target-language idioms only when the
  mapping is recorded in alignment evidence and preserves the relevant
  observable behavior or is recorded as an explicit gap. It must not optimize,
  redesign, or modernize the source project for its own sake;
- `redevelopmentScope` must declare explicit included paths, modules, or public
  surfaces. `excludedPaths[]` wins over included paths when they conflict;
- `sourceManifestDigest` must be produced before provider execution starts;
- oversized source scope must be decomposed into multiple Stories or stop
  blocked with a scoped `gapList[]`;
- all source modules, functions, public APIs, important behaviors, and fine
  details in scope must map to target artifacts or to explicit documented gaps;
- secrets, credentials, `.git`, dependency caches, build outputs, generated
  artifacts, and local environment files must be excluded from prompts, target
  output, and evidence unless policy explicitly allows a redacted digest-only
  record;
- license notices, copyright notices, and attribution required by the source
  project must be preserved or surfaced as a blocker;
- source-aligned redevelopment must not launder license obligations by rewriting
  identifiers or changing filenames;
- source-aligned redevelopment produces evidence-backed alignment, not a promise
  of perfect semantic identity. Any in-scope behavior or source detail that
  cannot be verified at an observable boundary must be recorded in `gapList[]`;
- source-aligned redevelopment must use existing B1 allowlisted step types. It
  must not invent workflow-specific root step types.

Required policy shapes:

```text
languageAdapterPolicy
adapterRegistryRef
requiredAdapters[]
adapterUnavailableBehavior = block | scoped_gap

semanticMappingPolicy
allowedMappingKinds[] = 1:1 | 1:N | N:1 | mapped_to_gap
requiresMappingRationale = true
forbidOptimizationForItsOwnSake = true

parityOraclePolicy
allowedOracleKinds[] = target_build | target_test | cli_golden | api_golden | serialization_fixture | error_exit_code | side_effect_check
sourceOnlyBehavior = gap | block
requiresTargetRunnableEvidence = true
```

Rules:

- invalid or missing policy fields stop during planner review before Story, job,
  provider, or target mutation;
- `adapterUnavailableBehavior=block` stops with `adapter_unavailable`;
- `adapterUnavailableBehavior=scoped_gap` is allowed only when policy also
  narrows the redevelopment scope and records every unsupported surface in
  `gapList[]`;
- `sourceOnlyBehavior=gap` records `source_only_untranslatable` gap entries;
- `sourceOnlyBehavior=block` stops with `source_only_untranslatable`;
- provider prose cannot fill missing policy fields or change policy outcomes.

Language adapter abstraction:

```text
languageAdapter
languageId
manifestExtractor
buildDiscovery
testDiscovery
publicSurfaceDiscovery
runtimeBoundary
ignoredArtifactRules
adapterVersion
adapterDigest
```

Rules:

- every source and target language must resolve through `languageAdapterPolicy`
  before provider execution;
- missing source or target adapters stop blocked with `adapter_unavailable` unless
  policy explicitly allows a narrower scoped run with all unsupported surfaces
  recorded in `gapList[]`;
- adapters produce language-neutral manifest records. Provider prose, comments,
  or chat transcripts cannot replace adapter output;
- adapter output must normalize module paths, exported symbols, public APIs,
  callable units, signature shape, visibility, dependency/runtime boundaries,
  and source locations when available;
- unknown language features, dynamic runtime behavior, framework-specific
  behavior, generated code, or dependency behavior that cannot be extracted
  deterministically must be recorded as `unknown` in the manifest and routed to
  parity checks or `gapList[]`;
- target-language idiom mapping is a controlled semantic mapping, not an
  optimization. Examples include class-to-struct-plus-impl, promise-to-async,
  exception-to-result, nullable-to-option, module-to-package, and
  runtime-specific API replacement;
- the same abstraction must handle same-language redevelopment and
  cross-language redevelopment. Same-language runs may use stricter manifest
  comparisons, but cross-language runs must use the same evidence fields.

Language-neutral manifest record shape:

```text
manifestRecordId
languageId
sourcePath
moduleId
symbolId
kind
visibility
signatureShape
runtimeBoundary
dependencyRefs[]
sourceLocation
extractionConfidence = deterministic | partial | unknown
```

Required source and alignment limits:

```text
maxSourceFiles
maxSourceBytes
maxMappedModules
maxMappedFunctions
maxAlignmentPasses
maxGapRepairAttempts
```

Required alignment evidence:

```text
sourceManifestDigest
targetManifestDigest
sourceLanguage
targetLanguage
sourceLanguageAdapterDigest
targetLanguageAdapterDigest
moduleAlignmentMap[]
functionAlignmentMap[]
renameMapDigest
behaviorParityChecks[]
buildAndTestResults
licenseNoticeRefs[]
gapList[]
```

Alignment evidence rules:

- `moduleAlignmentMap[]` and `functionAlignmentMap[]` must be derived from
  deterministic source/target manifest extraction, not provider prose;
- alignment map entries may be `1:1`, `1:N`, `N:1`, or `mapped_to_gap` when a
  target language requires structural translation. Each non-`1:1` entry must
  record a mapping rationale and the evidence or gap that justifies it;
- `behaviorParityChecks[]` must resolve to target-runnable concrete build, test,
  or command results where possible. Valid parity oracles include CLI/API golden
  I/O, serialization fixtures, error/exit-code checks, public API behavior,
  file/network side effects when in scope, and translated or reused source tests
  when they can run against the target;
- source-only tests or behaviors that cannot be expressed against the target
  language/runtime go directly to `gapList[]` or a blocked stop reason. They must
  be classified at manifest/mapping time before any repair step is enqueued and
  must not trigger repeated repair attempts;
- provider output may propose mappings or repairs, but it is not alignment
  evidence until Proofbound records a manifest diff, command result, validation
  result, or explicit gap record;
- anything that cannot be backed by manifest extraction or a passing check goes
  to `gapList[]`.

DONE rules:

- local source-aligned redevelopment DONE requires target build/test validation
  plus
  `localReviewCertified=true` when policy requires local review;
- Authority source-aligned redevelopment DONE requires the normal Authority
  receipt chain and `fullAuthorityDone=true` when full Authority DONE is
  requested;
- source-aligned redevelopment DONE must not be claimed while required
  module/function mappings or license obligations are unresolved;
- alignment-gap remediation consumes `maxGapRepairAttempts`,
  `maxRepairAttempts`, and `maxNoProgressIterations`;
- unresolved gaps default to blocked. Automatic follow-up Story creation
  requires policy allowance, remaining budget, and one explicit structured
  gap-to-story decision;
- no recursive redevelopment planning is allowed for v1.

Required source-aligned redevelopment fixtures:

| Fixture | Purpose | Expected evidence | Pass / block expectation |
| --- | --- | --- | --- |
| `redevelopment-supported-pair-matrix` | Prove the workflow is not pair-specific. The pass must run the same `source-aligned-redevelopment` workflow against at least two materially different language pairs, and every language pair claimed as supported by policy must pass this same fixture. Example claimed pairs may include `typescript -> rust`, `typescript -> swift`, `swift -> kotlin`, `typescript -> python`, and `typescript -> go`. | Same `developmentWorkflow`, canonical `sourceLanguage` / `targetLanguage`, source/target adapter digests, source/target manifest digests, alignment refs, target build/test refs, and gap refs when applicable. | Supported pairs reach selected-mode DONE or a policy-allowed blocked result through the same evidence schema. The run fails if a pair-specific workflow, step type, or evidence shape is used. |
| `redevelopment-pair-agnostic-plan-shape` | Prove pair differences are expressed through adapters and structured args, not special workflow names. | Planned steps use B1 allowlisted root types; language-specific differences appear only in adapter ids, structured command args, and evidence refs. | Blocks if any workflow name, root step type, or command operation encodes a pair such as `typescript-rust`. |
| `redevelopment-policy-schema-invalid` | Prove required policy fields are mechanical, not guessed by a provider. | Planner review errors for missing or invalid `languageAdapterPolicy`, `semanticMappingPolicy`, `parityOraclePolicy`, or `alignmentVerificationIntent[]`. | Blocks before Story creation, Authority job creation, provider execution, or target mutation. |
| `redevelopment-neutral-manifest-semantic-map` | Prove neutral manifests and semantic mapping work across structural translation. | Manifest records include module, symbol, kind, signature shape, runtime boundary, confidence, and source location when available. Alignment maps include `1:1`, `1:N`, `N:1`, and `mapped_to_gap` entries with rationale and evidence/gap refs. | Passes only when mappings come from deterministic manifest/command evidence; blocks if mappings are provider prose only. |
| `redevelopment-target-runnable-parity` | Prove parity checks execute against the target project instead of relying on source-only tests. | Target build/test/CLI/API/golden/serialization/error/side-effect command results with exit codes, digests, and evidence refs. | DONE is blocked if target-runnable parity evidence is missing for required behavior. |
| `redevelopment-source-only-untranslatable-no-loop` | Prove source-only behavior routes to gaps or block without burning repair loops. | `gapList[]` entry or `source_only_untranslatable` blocked stop, with `maxGapRepairAttempts`, `maxRepairAttempts`, and `maxNoProgressIterations` unchanged for that item. | Passes with explicit gap or blocked stop; fails if any repair attempt is consumed for the untranslatable item. |
| `redevelopment-missing-adapter-block` | Prove missing source or target language adapters fail before model work. | `adapter_unavailable` blocked stop, no provider event, no target mutation, and no manifest/evidence fabricated from provider prose. | Blocks cleanly unless explicit `scoped_gap` policy narrows scope and records unsupported surfaces. |
| `redevelopment-license-and-secret-negative` | Prove source-aligned redevelopment still preserves legal/security boundaries. | License notice refs are preserved or block; secrets, credentials, `.git`, caches, generated outputs, and env files are excluded from prompts, target output, and evidence except redacted digest-only refs allowed by policy. | Blocks on missing required notices or secret leakage. |

#### C2a-projection. Deterministic Projection Evidence Semantics (current pass)

The current pass implements the source-aligned redevelopment evidence model
through the deterministic plannedSteps executor, not through a live language
adapter or a real target build. This subsection pins exactly what that
projection may and may not claim, so projected evidence is never mistaken for
verified target parity. It is the literal contract the
`source.*` / `target.*` / `language.*` `lattice.command` operations satisfy.

Adapter availability (`language.resolve_adapters`):

- availability is a mechanical decision keyed by a single canonical language id,
  resolved against the adapter registry. The deterministic projection ships a
  fixed known-adapter set as the stand-in registry; a live deployment replaces
  it with the registry that `languageAdapterPolicy.adapterRegistryRef` resolves.
  Availability is per-language, never per-`source->target` pair, so the workflow
  stays pair-agnostic;
- `requiredAdapters[]` (falling back to `[sourceLanguage, targetLanguage]`) is
  split into available and unavailable language ids;
- if any required adapter is unavailable and
  `adapterUnavailableBehavior=block`, the step stops `blocked` with
  `adapter_unavailable` before any manifest extraction, provider event, or
  target mutation;
- if any required adapter is unavailable and
  `adapterUnavailableBehavior=scoped_gap`, the step passes but records one
  `adapter_unavailable_scoped_gap` entry in `gapList[]` per unavailable adapter,
  narrows the run to the available surfaces, and the run can never be
  redevelopment-DONE-eligible while those gaps are open. `scoped_gap` is allowed
  only because the policy explicitly requested it; the unsupported surfaces are
  always recorded, never silently dropped;
- provider prose can neither add an adapter to the registry nor change a block
  into a pass.

Neutral manifest extraction (`source.extract_manifest` /
`target.extract_manifest`):

- both operations emit `NeutralManifestRecord[]` using the language-neutral
  field shape (module/symbol/kind/visibility/signatureShape/runtimeBoundary/
  dependencyRefs/sourceLocation), so the same shape describes any language;
- source extraction derives module-granularity records from the deterministic
  source digest (real file paths + content digests) and marks
  `extractionConfidence=partial`: file/module identity is deterministic, but
  symbol-level shape is left `null`/unknown because the projection has no live
  parser. It never fabricates symbol signatures from prose;
- target extraction reports `extractionConfidence=unknown` with zero records in
  the projection: the target project is the thing being built, so there is no
  target manifest to read yet. This is recorded honestly rather than guessed.

Semantic mapping and gap rules (`source.compare_alignment` /
`source.record_gaps`):

- `moduleAlignmentMap[]` / `functionAlignmentMap[]` entries are derived only
  from manifest extraction (`derivedFrom=manifest_extraction`), never from
  provider prose. The entry schema supports `1:1`, `1:N`, `N:1`, and
  `mapped_to_gap`, and `semanticMappingPolicy.allowedMappingKinds[]` is echoed
  with the produced evidence;
- because target manifest extraction is `unknown` in the projection, every
  source module aligns as `mapped_to_gap` with a rationale and a `gapRef` into
  an `unverified_alignment` gap. The projection therefore proves provenance and
  schema, and refuses to assert `1:1` parity it cannot back with a target
  manifest;
- `source.record_gaps` aggregates every gap surfaced by earlier steps into a
  single `gapList[]`. Source-only / untranslatable items are classified at
  manifest/mapping time and routed straight to `gapList[]`; they never enqueue a
  repair attempt and never consume `maxGapRepairAttempts` /
  `maxRepairAttempts` / `maxNoProgressIterations`.

Target-runnable parity (`source.build_parity_oracles` /
`target.run_parity_oracles`):

- `source.build_parity_oracles` builds the `behaviorParityCheck[]` catalog from
  `parityOraclePolicy.allowedOracleKinds[]`, each `status=planned`;
- `target.run_parity_oracles` is the honesty boundary. The deterministic
  projection runs no target build/test, so it captures no target-runnable
  evidence: every check is recorded `status=not_run` with
  `targetRunnableEvidenceCaptured=false`, and each required check is routed to a
  `target_runnable_parity_missing` gap;
- when `parityOraclePolicy.requiresTargetRunnableEvidence=true` (the required
  setting) and no target-runnable evidence is captured,
  `targetParityVerified=false` and the run is not redevelopment-DONE-eligible.
  Target parity is never claimed from a projected or prose result.

Executor result fields and DONE boundary:

- a redevelopment plannedSteps execution surfaces a `redevelopment` summary with
  at least `sourceLanguage`, `targetLanguage`, `sourceManifestDigest`,
  `targetManifestDigest`, `sourceManifestRecordCount`, `alignmentEntryCount`,
  `mappedToGapCount`, `adapterUnavailable[]`, `targetRunnableEvidenceCaptured`,
  `targetParityVerified`, `gapCount`, and `doneEligible`;
- `doneEligible` requires `targetParityVerified=true` and zero open gaps; the
  deterministic projection is therefore never redevelopment-DONE-eligible by
  itself, exactly as `localDone`/`authorityDone`/`receiptVerified` stay false
  for a projected standard run. Redevelopment DONE still requires real
  target build/test evidence plus the normal local-review or Authority receipt
  chain;
- the projection is forward-compatible: when a live adapter and a real target
  build supply genuine extraction and target-runnable parity evidence, the same
  fields carry `extractionConfidence=deterministic`, real `1:1`/`1:N`/`N:1`
  mappings, `status=passed` checks, and `targetParityVerified=true` without any
  schema change.

### C3. Job Planner

Job Planner input:

```text
storyId
storyPhase
background
checklist[]
verificationIntent[]
developmentWorkflow
sourceAlignedRedevelopmentSpec
authorityPolicy
providerPolicy
retryPolicy
stopPolicy
evidencePolicy
receiptPolicy
worktreePolicy
multiHostPolicy
```

Job Planner output:

```text
jobCreateRequest
localRunPlan
plannedSteps[]
developmentWorkflow
sourceAlignedRedevelopmentDigest
providerPolicy
retryPolicy
stopPolicy
evidencePolicy
receiptPolicy
multiHostPolicy
plannerDigest
```

In authority mode, the Job Planner must create an Authority job with first-class
typed `plannedSteps[]`. In local mode, it must create a local run plan with the
same typed `plannedSteps[]` contract, local evidence anchors, and
`multiHostPolicy` when local review is required. It must not hide step details
inside prompt text or generic metadata.

Signed Authority job creation envelope:

```text
jobCreateRequestEnvelope
kind = authority_job_create
projectId
storyId
plannerRunId
authorityMode = enforce
createdAt
actorId
actorRole
actorKeyId
canonicalPayloadDigest
storyDigest
plannerDigest
plannedStepsDigest
policyDigest
idempotencyKey
signatureAlgorithm = ed25519
signature
```

Rules:

- the signed payload binds Story, planner draft, `plannedSteps[]`, policies,
  idempotency key, actor id, key id, and creation time;
- the Authority server must verify the actor key, signature, canonical payload
  digest, policy digest, idempotency key, and production test-key restrictions
  before creating a job;
- duplicate job creation with the same idempotency key and same digest is
  idempotent; the same key with a different digest fails with
  `job_create_idempotency_conflict`;
- invalid signature, unknown key, stale/future timestamp, digest mismatch, or
  policy mismatch fail before the job is visible to runners;
- signed job creation failure does not downgrade to a local run plan unless the
  user explicitly selected `local` / `non-authority` mode before planning.

Each planned step must include:

```text
stepId
type
title
purpose
cwdPolicy
timeoutMs
maxAttempts
requiresCleanWorktree
producesEvidence
blocksUntilEvidenceUploaded
provider
validationBinding
repairBinding
evidenceBinding
args
```

Initial generated step sequence for implementation work:

```text
lattice.command with args.operation=story.resolve
lattice.command with args.operation=context.read
provider.codex or provider.fake
validate.run
provider.codex or provider.fake with args.operation=repair when needed
validate.run with args.operation=retry when needed
codex.verify when adapter files changed
gate.evaluate
story.advance
stop.summary
```

For `developmentWorkflow=source_aligned_redevelopment`, the generated plan still
uses only the B1 allowlisted root step types, but its structured `args` must
include source and target language resolution, source manifest extraction,
target manifest extraction, rename-map application, module/function alignment
checks, target-runnable behavior parity checks, gap recording, and license notice
verification.

Required `lattice.command` operations for source-aligned redevelopment:

```text
language.resolve_adapters
source.extract_manifest
target.extract_manifest
source.compare_alignment
source.verify_rename_map
source.build_parity_oracles
target.run_parity_oracles
source.verify_license_notices
source.record_gaps
```

The Job Planner must not invent root step types outside the B1 allowlist. Repair,
retry, context loading, and story resolution are expressed through allowlisted
step types plus structured `args`, bindings, and policy, not through new step
type strings.

The planner may omit steps that are not relevant, but it must explain why in the
draft or job planning output.

### C4. Planner Methodology Rules

The planner uses these methodology rules:

- start by identifying the concrete user outcome;
- split broad requests into one Story at a time;
- ask zero follow-up questions in `autonomous`, 5-10 sufficiently detailed
  questions in `interview`, and only major-decision questions in
  `decision-gated`;
- prefer explicit assumptions over silent guessing when risk is low;
- stop for human review when ambiguity affects scope, safety, cost, or DONE
  semantics;
- create small tasks that can be verified independently;
- every task must have a verification path;
- every provider step must have a timeout and evidence binding;
- every validation step must have an expected result;
- no placeholders, `TBD`, or vague "implement later" text in planned steps;
- TDD or test-first steps should be generated when the change can reasonably be
  tested before implementation;
- spec compliance review happens before code quality review when reviewer steps
  are generated.

### C5. Planner Safety Policy

Planner behavior is controlled by a structured `plannerPolicy` discovered from
Authority policy, local policy, or the explicit planner run request.

Minimal `plannerPolicy` shape:

```text
allowUnattendedPlanning
allowedInteractionModes[]
highRiskAmbiguityCategories[]
allowExternalDeployment
allowRemotePush
allowDestructiveGit
allowMultiStoryPlanning
requiresConfirmationBeforeStoryCreate
maxStoriesPerRequest
forceNewRunAllowed
```

Defaults:

- `allowUnattendedPlanning` defaults to `false` in authority mode unless policy
  explicitly sets it to `true`;
- `requiresConfirmationBeforeStoryCreate` defaults to `true` when
  `allowUnattendedPlanning` is false;
- runtime linkage (B-e3d9): `defaultPlannerPolicy` sets
  `requiresConfirmationBeforeStoryCreate`, and `planner_create_story` checks the
  persisted `confirmationDigest` before calling `story_create`; missing
  confirmation returns `confirmation required before Story creation`, while
  `planner_answer` confirmation and local autonomous policy are both covered by
  `planner-unattended-smoke`;
- remote push, destructive git, production migration, and external deployment
  default to disallowed;
- `maxStoriesPerRequest` defaults to `1`.

The planner must fail closed for:

- requests that require credentials not configured;
- requests that require external deployment not configured;
- requests that imply remote push, production migration, or destructive git
  operations without explicit policy;
- requests that span multiple independent subsystems without decomposition;
- requests whose acceptance criteria cannot be verified;
- requests that would require direct writes to managed Story or fixture JSON;
- requests that ask the planner to bypass Authority receipts.

For low-risk ambiguity during initial planning, the planner may record an
assumption and continue. For high-risk ambiguity before a Story/job or local run
plan exists, it must produce `blocked` with `scopeQuestions[]`. For
policy-allowed high-risk ambiguity discovered after confirmed planning or during
execution, `autonomous` and `interview` use the host decision wave from X9.

Ambiguity classification must be recorded in planner evidence:

```text
ambiguityClassification = low_risk_assumption | high_risk_blocked | host_decision_required
ambiguityCategory
assumptionOrQuestionId
policyRule
```

### C6. Planner Evidence And Authority Binding

Planner output must become evidence, not hidden prompt context.

Required planner evidence:

```text
plannerDraftId
naturalLanguageDigest
interactionMode
questionsDigest
answersDigest
confirmationDigest
decisionReceiptDigests[]
plannerDigest
storyDraftDigest
jobPlanDigest
plannedStepDigests[]
assumptions[]
scopeQuestions[]
createdStoryId
createdJobId
```

The Authority job must bind:

- planner digest;
- story id;
- checklist item ids when available;
- verification intent digest;
- planned step digests;
- retry/stop/evidence/receipt policy digests.

Gate evaluation must be able to see which planner output created the job that
produced the evidence.

### C7. Natural-Language-To-DONE Flow

The complete flow is:

```text
receive natural-language request
select interactionMode
run planner draft
if interactionMode=interview: ask 5-10 questions, record answers, require confirmation
run planner review
if interactionMode=decision-gated: pause only for required major decisions
if safe and allowed: create Proofbound Story
if not safe: stop with scope questions
derive Authority job + typed plannedSteps[]
submit job to Proofbound Authority
run Stage B executor
execute provider and validation steps
upload evidence
request gate evaluation
verify native gate_decision receipt
report per-run authority DONE or blocked
if full authority DONE is requested: submit/wait/reconcile host verdicts
report full authority DONE only after multi-host verification passes
```

`planner run --mode=authority --until=DONE` may execute this full flow only when
`plannerPolicy.allowUnattendedPlanning=true`. Otherwise it must stop after
draft/review and require approval before story/job creation.

### C8. Stage C Exit Criteria

Stage C is complete when:

- a natural-language request can produce a valid Story draft;
- `autonomous` mode can run without user confirmation and blocks instead of
  asking when risk is too high;
- `interview` mode asks 5-10 sufficiently detailed questions, records answers,
  and requires one confirmation before Story/job creation;
- `decision-gated` mode pauses for major decisions only and records decision
  receipts before continuing;
- planner review rejects placeholder, vague, overbroad, or unverifiable drafts;
- Story creation uses Proofbound commands only;
- Job Planner creates a signed Authority job with typed `plannedSteps[]`;
- planned steps include validation, evidence, retry, stop, and receipt policy;
- Stage B can consume the generated job without hand-editing;
- final evidence links natural language request, planner draft, Story, job,
  planned steps, provider events, validation, and receipt;
- unsafe or ambiguous requests stop with questions instead of guessing;
- local/shadow/authority mode boundaries remain intact.

## Cross-Stage Closure Requirements

The complete natural-language-to-DONE path needs several closure rules that span
planner, executor, Proofbound lifecycle, and Proofbound Authority. These rules are
mandatory because otherwise a run can appear complete while one link in the
chain is still only local, inferred, duplicated, or stale.

### X1. Structured Planner Output Gate

Planner output is provisional until it passes schema and review gates.

Rules:

- planner output must be machine-readable JSON, not prose-only text;
- planner output must validate against Story Planner and Job Planner schemas;
- planner output must contain no placeholders such as `TBD`, `TODO`,
  `implement later`, or vague "add tests" instructions;
- every generated checklist item must have verification intent;
- every generated planned step must have a concrete type, cwd policy, timeout,
  retry policy, evidence binding, and validation or gate relationship;
- low-risk assumptions must be explicit;
- high-risk ambiguity before confirmed execution must produce `scopeQuestions[]`
  and stop;
- policy-allowed high-risk ambiguity during confirmed unattended execution must
  produce host decision evidence or stop blocked;
- schema-valid planner output is still not authority evidence until it is bound
  into an Authority job and later consumed by gate evaluation.

### X2. Story Lifecycle Bootstrap

Natural-language-to-DONE cannot jump directly from a request to provider
execution. It must bootstrap the Proofbound Story lifecycle through Proofbound
commands.

Required bootstrap sequence:

```text
planner draft
planner review
story_draft or story_create
checklist / verification intent materialization
story_advance INIT_CHECK when needed
worktree creation / resolver lookup
story_review or PLAN gate when required
story_advance DEV when allowed
Authority job creation
Stage B executor
```

Rules:

- Story creation and advancement use Proofbound commands only;
- planner-created Stories must not skip required lifecycle gates;
- the executor must run in the authoritative story worktree, not the main mirror;
- if the Story is still in IDEA, INIT, INIT_CHECK, PLAN, REVIEW, TEST, DONE, or
  DISCARDED, the planner/executor must select the legal next action instead of
  assuming DEV;
- if lifecycle bootstrap fails, the run stops before creating executable
  provider jobs unless policy explicitly allows creating a planning-only job.

### X3. Checklist-To-Evidence Coverage Binding

DONE requires evidence coverage, not just a successful provider run.

The Job Planner must produce a coverage map:

```text
checklistItemId
verificationIntentDigest
plannedStepIds[]
validationStepIds[]
evidenceRefs[]
expectedArtifacts[]
gatePredicate
```

Gate evaluation input must include this coverage map or a digest of it. The gate
must be able to answer:

- which checklist item was implemented;
- which planned step attempted it;
- which validation checked it;
- which evidence proves it;
- which artifacts changed;
- which failures or reviewer findings remain.

If any checklist item has no verification intent, no validation path, or no
evidence binding, authority DONE must fail closed.

### X4. DONE Reconciliation And Cleanup

The final state must reconcile local lifecycle, Authority receipt, job status,
and workspace cleanup.

Per-run `authorityDone` is true only when:

```text
local lifecycle reached DONE or an approved authority target state
all required validation evidence is uploaded
all required checklist coverage bindings are satisfied
Proofbound Authority issued native gate_decision receipt
Proofbound verified the receipt signature and bindings
Authority job is completed with final summary
no required lease is left active
final JSON reports localDone=true and authorityDone=true
```

Full `fullAuthorityDone` is a stronger release-certification state. It requires
per-run `authorityDone=true` plus a passing multi-host final verification gate
from X9. Single-host receipt verification must not be labeled full authority
DONE.

If local lifecycle reaches DONE but receipt verification fails, final status is
not authority DONE. If Authority approves but local lifecycle cannot legally
advance, final status is not local DONE. Both cases must produce a blocked or
failed summary with the exact missing link.

Cleanup requirements:

- release or complete the Authority job;
- record final stop/completion summary;
- preserve unrelated user worktree changes;
- report any remaining worktree, branch, lease, or receipt gap;
- never silently merge, push, or delete user work outside Proofbound lifecycle
  rules.

### X5. Resume, Idempotency, And Duplicate Prevention

Unattended runs must be restartable or fail-safe.

Rules:

- natural-language requests use a `naturalLanguageDigest`;
- planner drafts use `plannerDraftId` and `plannerDigest`;
- Story creation uses an idempotency key so rerunning does not create duplicate
  Stories for the same approved request;
- Job creation uses an idempotency key bound to story id, planner digest, and
  planned step digest;
- evidence upload uses job id, step id, attempt number, evidence kind, and a
  per-record sequence or content digest as the idempotency key;
- gate evaluation uses `gateInputDigest`;
- job completion/release is idempotent;
- after a crash, the next run must either resume from the last safe state or
  release the lease and stop with a local non-authority summary;
- duplicate natural-language requests must point to the existing draft/story/job
  unless the user or policy explicitly requests a new run.

Required idempotency key composition:

```text
plannerRunKey = sha256(projectId, normalizedRequestDigest, interactionMode, plannerPolicyVersion)
storyIdempotencyKey = sha256(projectId, plannerDigest, confirmationDigest, decisionReceiptDigests[])
jobIdempotencyKey = sha256(storyId, plannerDigest, plannedStepDigests[], authorityPolicyVersion)
evidenceIdempotencyKey = sha256(jobId, stepId, attemptNumber, evidenceKind, recordSequenceOrContentDigest)
gateIdempotencyKey = gateInputDigest
```

Rules:

- `normalizedRequestDigest` is exact normalized text, not a semantic similarity
  guess;
- `recordSequenceOrContentDigest` must distinguish multiple evidence records of
  the same kind emitted by the same step attempt;
- near-duplicate detection may warn, but it must not replace deterministic
  idempotency keys;
- rerunning the same request with a different `interactionMode` creates or
  references a distinct planner run unless policy explicitly maps modes
  together;
- forcing a new run requires `--forceNewRun` plus a non-empty reason when
  `plannerPolicy.forceNewRunAllowed=true`;
- when `--forceNewRun` is used, downstream Story creation may use
  `lattice story_create --forceNew`, but only through the planner-controlled
  Story creation path;
- if an existing draft/story/job conflicts with the requested mode or policy,
  the planner must report the existing ids and stop blocked rather than create a
  duplicate silently.

### X6. Planner And Executor Budget Policy

Complete unattended mode must be bounded by cost and time.

Required budget fields:

```text
maxPlannerQuestions
maxPlannerAttempts
maxStoriesPerRequest
maxJobsPerStory
maxPlannedSteps
maxProviderCalls
maxSourceFiles
maxSourceBytes
maxMappedModules
maxMappedFunctions
maxAlignmentPasses
maxGapRepairAttempts
maxReviewWaves
maxVerifierWaitMs
maxWallClockMs
maxTokenOrCostBudget
```

If any budget is exceeded, the run stops with `blocked` and reports the next
manual action.

Budget rules:

- known token and cost usage must be recorded in `budgetUsage`;
- unknown token usage still consumes provider call and wall-clock budgets;
- budget exhaustion stops `blocked` and must not trigger provider fallback,
  extra review waves, recursive redevelopment planning, or silent scope
  reduction;
- source-aligned redevelopment source ingestion and alignment checks consume the
  source and alignment limits above.

### X7. Operator Timeline And Audit Output

The final output must be auditable without reading raw logs.

Required timeline entries:

```text
request received
planner draft created
planner review passed or blocked
story created or reused
story worktree resolved
authority job created or reused
job claimed
step started/completed/failed
evidence uploaded
validation passed/failed
gate evaluated
receipt verified/failed
review wave started/completed/blocked
host verdict submitted
local review certified/failed
story advanced
job completed/released
final status
```

Final JSON and final human-readable summary must include the timeline, key
digests, created/reused ids, evidence refs, receipt refs, DONE flags, blocked
reason, and next action.

### X8. Core AI Execution Principle: Anti-Over-Optimization Gate

This is a core AI execution principle for the whole development flow.

Whenever the AI proposes an optimization, refactor, abstraction, extra checklist
item, broader architecture change, or "nice to have" improvement, it must first
challenge its own suggestion. The planner, executor, provider prompt, and
reviewers must repeatedly ask whether the proposed change is required for the
requested outcome. This is a lightweight self-questioning gate, not a new
interview loop.

Core question:

```text
Is this change necessary to satisfy the user request, lifecycle gate,
verification intent, evidence requirement, or safety policy?
```

If the answer is no, the change is deferred.

AI self-question triggers:

- before adding checklist items;
- before adding planned steps;
- before suggesting optimization or refactor work;
- before changing architecture or shared contracts;
- before expanding scope from one Story to multiple Stories;
- before reviewer findings that are not tied to a concrete bug, gate,
  verification gap, or user-visible risk;
- before provider execution that touches files outside the minimal scope.

Rules:

- planner must not add checklist items, architecture work, abstractions, or
  provider steps that are not needed for the requested outcome;
- Job Planner must prefer the smallest executable `plannedSteps[]` set that can
  satisfy verification intent and receipt gate;
- provider prompts must tell the provider to avoid unrelated refactors,
  speculative optimization, style churn, and broad cleanup;
- reviewer prompts must classify "extra optimization not required by scope" as
  a finding when it increases risk, cost, or review burden;
- final multi-host review prompts must explicitly include the principle
  `dont optimize for the sake of optimization`;
- executor may perform local cleanup only when it is required for tests, gates,
  safety, or user-visible correctness;
- performance, architecture, or UX improvements that are not required by the
  current Story become follow-up Story suggestions, not hidden scope expansion.

Evidence:

- planner output should include `deferredOptimizations[]` when useful;
- final summary should report any intentionally deferred improvements;
- DONE must not require deferred optimizations.

This gate protects development speed. It should prevent unnecessary work, not
force extra user questions.

### X9. Multi-Host Final Verification And Local Review Gate

Final unattended certification must use more than one execution host. The
purpose is independent verification, not duplicated implementation work.

This mechanism supports two development modes:

| Mode | Review anchor | Storage | Blocking target |
| --- | --- | --- | --- |
| `local` / `shadow` non-authority | `validationDigest`, `materialHash`, local evidence refs, and local lifecycle state. | Proofbound local run state keyed by `storyId` and local `runId`. | `localReviewCertified` only. |
| `authority` | verified `gate_decision` receipt, `gateInputDigest`, Authority evidence refs, and per-run DONE flags. | Proofbound Authority verdict endpoints keyed by `jobId` and `runId`. | `fullAuthorityDone` only. |

Minimum policy:

```text
minIndependentHosts = 2
targetHostsPerWave = 2-3
preferredHostsForReleaseCertification = 3+
preferredVerifierProviders[] may include codex, claude, gemini
```

Rules:

- one host may be the primary planner/executor/implementer;
- at least one other independent verifier host must review the final artifacts
  before local certified DONE or full Authority DONE can be claimed;
- release certification may prefer three or more independent hosts, including
  Gemini when it is registered and available, but preferred hosts do not block
  unless policy marks them required;
- Gemini is a verifier host by default, not a new `provider.gemini` planned-step
  executor;
- hosts count as independent only when they use different registered host ids
  and at least one materially independent execution dimension, such as provider,
  runtime, local session, credential/key binding, or execution process;
- two verdicts from the same provider session, same fake provider fixture, same
  host id, same copied transcript, or same unauthenticated identity do not count
  as independent;
- the verifier host does not need to re-implement the work, but it must inspect
  the produced artifacts, run or verify the required checks, and issue a
  structured verdict;
- fake provider runs are valid for deterministic fixtures but do not count as an
  independent final verification host;
- the Codex coordinator may coordinate work and summarize results, but it does
  not count as an independent verifier unless it also runs as a separate
  registered host under the independence rules above;
- the review prompt profile must include the instruction
  `dont optimize for the sake of optimization`;
- final DONE certification must run three bounded host-check waves before
  claiming local certified DONE or full Authority DONE. Each wave must use at
  least two independent hosts when policy requires multi-host review, should
  prefer three hosts when available, and must review the same final anchors for
  that wave;
- every final host-check prompt in all three waves must include these principles:
  `don't optimize for the sake of optimization`, `don't optimize arbitrarily`,
  `only fix real correctness issues`, and `preserve consistency of logic`;
- a host-check finding may block only when it is tied to a concrete correctness
  issue in the final anchors, lifecycle gate, receipt/evidence chain, security
  boundary, or user-requested behavior;
- if a blocking issue is repaired and the material state changes, the affected
  anchors become stale and the final three-wave check restarts over the fresh
  anchors;
- the multi-host gate runs at final check/release certification time and high
  risk final gates, not before every small planned step.

Blocking rules:

- per-run `authorityDone` is receipt-backed and must not wait for host verdicts;
- `fullAuthorityDone` requires per-run `authorityDone=true` plus a passing
  Authority multi-host final verification gate;
- local non-authority lifecycle DONE may be achieved without Authority, but the
  local certified-final label requires `localReviewCertified=true` when policy
  requires multi-host local review;
- local review must never set `authorityDone`, `fullAuthorityDone`, or
  `multiHostVerified`.

Authority ordering:

- Proofbound Authority issues and stores the native `gate_decision` receipt before
  the Authority multi-host final verification gate is evaluated;
- verifier hosts inspect the verified receipt, gate input digest, evidence refs,
  planned step digests, and final per-run DONE flags;
- Authority multi-host verification is a final projection/certification gate
  over the receipt-backed run, not a prerequisite for issuing the receipt;
- this ordering prevents receipt/verdict deadlock: host verdicts depend on the
  receipt, while `fullAuthorityDone` depends on host verdicts.

Local ordering:

- local validation must pass before local host verdicts can certify the run;
- verifier hosts inspect the local validation digest, material hash, evidence
  refs, changed files, commands run, and local lifecycle state;
- local host verdicts certify only the local result. They are diagnostic for
  production and cannot substitute for Authority receipts.

Required host verdict record:

```text
verdictId
reviewWaveId
reviewPromptProfile
reviewPromptDigest
hostId
provider
model
role = implementer | verifier | reviewer
storyId
runId
jobId
checkedEvidenceRefs[]
checkedReceiptId
checkedGateInputDigest
checkedValidationDigest
checkedMaterialHash
checkedCommit
commandsRun[]
verdict = pass | fail | blocked
findings[]
artifactDigest
issuedAt
```

Authority verdicts require `jobId`, `checkedReceiptId`, and
`checkedGateInputDigest`. Local non-authority verdicts omit those Authority-only
fields and instead require `checkedValidationDigest`, `checkedMaterialHash`, and
local evidence refs.

Verifier authenticity rules:

- Authority verdict submission must be authenticated by a registered actor or
  host key;
- Authority derives `hostId`, session, runner, and key binding from the
  authenticated context instead of trusting those fields from the JSON body;
- local verdict submission must record the local host identity source and must
  not count two submissions from the same host/session as independent;
- duplicate same-host or same-session verdicts are accepted for audit but do not
  increase the independent host count.

The final gate may pass only when the required independent host verdict records
exist and all required verifier verdicts are `pass`.

Verdict submission:

```bash
lattice authority verdict submit --jobId=<job> --runId=<run> --verdictFile=<verdict.json> --json
lattice autopilot review submit --storyId=<story> --runId=<run> --verdictFile=<verdict.json> --json
```

Authority API:

```text
POST /v1/jobs/{jobId}/verdicts
GET /v1/jobs/{jobId}/verdicts
```

Rules:

- submitted Authority verdicts must bind `jobId`, `runId`, `storyId`, evidence
  refs, receipt id, gate input digest, host identity, provider, model, review
  wave id, prompt digest, material hash, and artifact digest;
- submitted local verdicts must bind `runId`, `storyId`, evidence refs,
  validation digest, material hash, host identity, provider, model, review wave
  id, prompt digest, and artifact digest;
- Authority stores Authority verdict records as final verification evidence;
- local Proofbound stores local verdict records as local review evidence;
- `authority job status` must show Authority verdict count, independent verifier
  count, failing findings, and whether the Authority multi-host gate is
  satisfied;
- `autopilot review status` must show local verdict count, independent verifier
  count, failing findings, and whether `localReviewCertified` is satisfied.

Host invocation:

- the primary executor does not silently spawn or impersonate verifier hosts;
- the Codex coordinator, CI script, or operator-supervised release step starts
  separate verification hosts after the local validation pass or per-run receipt
  is available;
- the primary executor or coordinator may poll local review state or
  `GET /v1/jobs/{jobId}/verdicts` until the required verifier verdicts arrive or
  the budget expires;
- no pub/sub, webhook, dashboard, voting engine, or new orchestration substrate
  is required for v1.

Reconciliation protocol:

- if any required independent verifier verdict is `fail` or `blocked`, local
  review certification or `fullAuthorityDone` is blocked with
  `multi_host_disagreement`;
- if all failing findings map to planned repair policy and budget remains, the
  executor may return the Story to DEV, run repair steps, and revalidate;
- after any repair that changes artifacts, evidence, material hash, local
  lifecycle state, planned-step outputs, or Authority gate input, all previous
  affected verdicts are stale for final certification;
- after such repair in local mode, Proofbound must rerun validation, compute fresh
  local anchors, and start a fresh review wave;
- after such repair in Authority mode, Proofbound must rerun validation, rebuild
  gate input, request and verify a fresh `gate_decision` receipt, and then start
  a fresh review wave over the new chain;
- if findings cannot be repaired unattended, the run stops blocked with the
  failing verdict ids, findings, and next action;
- single-host evidence may be reported as diagnostic progress, but it must never
  be labeled local review certified or full multi-host Authority DONE.

Host decision waves for mid-run ambiguity:

- `autonomous` and post-confirmation `interview` runs may use the same
  independent-host machinery to resolve high-risk ambiguity or major decisions
  that policy allows hosts to decide without the user;
- a host decision wave is not a final DONE verdict and must be stored as
  structured decision evidence, not as `localReviewCertified` or
  `fullAuthorityDone`;
- decision evidence must include `decisionWaveId`, triggering risk category,
  question or ambiguity text, options considered, selected resolution, host
  verdict refs, policy version, and budget usage;
- at least two independent hosts must agree on the resolution before the
  executor may continue;
- if hosts disagree, fail, block, or exhaust budget, the run stops blocked unless
  `decision-gated` policy requires a human decision and the run is already in
  `decision-gated` mode;
- host decision waves use the anti-over-optimization rule and must ask whether a
  proposed clarification or expansion is required for the requested outcome,
  lifecycle gate, verification intent, evidence requirement, or safety policy;
- no voting engine, pub/sub, dashboard, webhook, or per-step review loop is
  required for v1.

## Server Requirements

Proofbound Authority must provide or confirm support for:

- actor key registration with production bootstrap guard;
- policy discovery with server key metadata;
- runner registration and heartbeat;
- job queue, leases, claim, release, and completion;
- typed `plannedSteps[]` on job creation and claim responses;
- planner/job-plan digests bound into job records;
- run records and provider events;
- evidence records;
- gate evaluation and native signed `gate_decision` receipts;
- receipt fetch by id;
- authenticated multi-host verdict submission and independence counting;
- `multiHostPolicy` discovery with required and preferred verifier providers;
- Postgres persistence;
- Alembic migrations;
- deployment configuration under Proofbound Authority names;
- HTTPS or trusted tunnel for deployed verification;
- audit logs for actor, runner, job, evidence, and receipt operations.

Minimal stable Authority endpoints for this pass:

| Endpoint | Purpose | Status before M6 |
| --- | --- | --- |
| `GET /health` | Deployment and liveness check. | confirm `existing` / `partial` / `missing` |
| `GET /v1/authority/policy` | Discover server key, policy, command and evidence contracts. | confirm `existing` / `partial` / `missing` |
| `POST /v1/actors/{actorId}/keys` | Bootstrap/register actor keys. | confirm `existing` / `partial` / `missing` |
| `POST /v1/runners/register` | Register runner identity and capabilities. | confirm `existing` / `partial` / `missing` |
| `POST /v1/runners/{runnerId}/heartbeat` | Runner heartbeat. | confirm `existing` / `partial` / `missing` |
| `POST /v1/jobs` | Create signed Authority job. | confirm `existing` / `partial` / `missing` |
| `GET /v1/jobs/{jobId}` | Read job/run status. | confirm `existing` / `partial` / `missing` |
| `GET /v1/projects/{projectId}/jobs` | List jobs for duplicate/resume/status handling. | confirm `existing` / `partial` / `missing` |
| `POST /v1/runners/{runnerId}/jobs/claim` | Claim the next eligible job. | confirm `existing` / `partial` / `missing` |
| `POST /v1/jobs/{jobId}/heartbeat` | Renew job lease. | confirm `existing` / `partial` / `missing` |
| `POST /v1/jobs/{jobId}/release` | Release claimed job. | confirm `existing` / `partial` / `missing` |
| `POST /v1/runs/{runId}/events` | Append command, validation, repair, summary, and completion events. | confirm `existing` / `partial` / `missing` |
| `POST /v1/runs/{runId}/provider-events` | Append provider events. | confirm `existing` / `partial` / `missing` |
| `GET /v1/runs/{runId}` | Read run state. | confirm `existing` / `partial` / `missing` |
| `GET /v1/runs/{runId}/events` | Read run event evidence. | confirm `existing` / `partial` / `missing` |
| `POST /v1/evidence` | Upload single evidence envelope. | confirm `existing` / `partial` / `missing` |
| `POST /v1/evidence/batch` | Upload evidence batches. | confirm `existing` / `partial` / `missing` |
| `POST /v1/gates/evaluate` | Request native signed `gate_decision` receipt. | confirm `existing` / `partial` / `missing` |
| `GET /v1/receipts/{receiptId}` | Fetch receipt by id. | confirm `existing` / `partial` / `missing` |
| `POST /v1/jobs/{jobId}/verdicts` | Submit multi-host verifier verdict. | confirm `existing` / `partial` / `missing` |
| `GET /v1/jobs/{jobId}/verdicts` | List multi-host verifier verdicts. | confirm `existing` / `partial` / `missing` |

Rules:

- before M6 begins, Agent 1 must replace every `confirm ...` status with
  `existing`, `partial`, or `missing` evidence from the running Proofbound Authority
  server;
- `POST /v1/gates/evaluate` must explicitly state whether the server already
  mints native signed `gate_decision` receipts. If it does not, receipt issuance
  is the first server task before Stage B authority DONE can be implemented;
- `partial` and `missing` statuses must map to a server Story or a blocked start
  decision. CLI agents must not guess endpoint behavior from names or docs.

The Python server may keep existing compatibility aliases, but the Proofbound
Authority track must document any alias used by the CLI and must not leave the
Stage B executor guessing endpoint names.

Authority verdict endpoints must authenticate the submitting actor or host and
derive host identity from the authenticated context. Submitted JSON may bind the
claimed `hostId` for audit, but it is not the source of truth for independence
counting.

## Proofbound CLI Requirements

Proofbound CLI must provide:

- canonical `LATTICE_AUTHORITY_*` settings with legacy alias fallback;
- native actor envelope signing;
- native receipt verification;
- live runner control-plane client;
- authority job consumer;
- Proofbound-native Story Planner;
- Proofbound-native Job Planner;
- bounded provider executor;
- structured evidence uploader;
- gate evaluation client;
- local non-authority review verdict store and status commands;
- multi-host review-wave reconciliation for local and Authority modes;
- autopilot local / shadow / authority separation;
- process-fact and command-policy entries for all new command surfaces;
- global `lattice` verification after build/install.

## Milestones

Recommended delivery uses sixteen milestones. Milestones 1-5 complete Stage A.
Milestones 6-12 complete Stage B and deployment hardening. Milestones 13-15
complete Stage C and prove natural-language-to-DONE. Milestone 16 proves
multi-host final verification.

| Milestone | Name | Main outcome |
| --- | --- | --- |
| M1 | Contract Lock | Requirements, field contracts, command names, env names, and receipt semantics are frozen. |
| M2 | Cross-Language Crypto Fixtures | Python and TypeScript agree on canonical JSON, Ed25519 signing, timestamps, and key encodings. |
| M3 | Authority Metadata And Bootstrap | Proofbound Authority exposes server key metadata and production-safe actor key registration. |
| M4 | Native Receipt Verifier | Proofbound verifies native `gate_decision` receipts and rejects wrong bindings. |
| M5 | Live Runner Control Plane | Proofbound live runner registers, heartbeats, claims, and releases jobs without provider execution. |
| M6 | Authority Job Schema | Jobs, planned steps, leases, retry policy, stop policy, provider policy, worktree policy, evidence policy, receipt policy, and multi-host policy are machine-readable. |
| M7 | Provider Executor | Codex/Claude/fake provider execution is bounded, captured, and scoped to the story worktree. |
| M8 | Evidence Upload | Runs, provider events, command events, validation results, git state, and summaries upload to Authority. |
| M9 | Repair And Stop Policy | Failures retry, repair, return to DEV, or stop blocked according to explicit policy. |
| M10 | Gate Evaluation Loop | Executor requests gate evaluation and verifies returned native receipts before authority DONE. |
| M11 | End-To-End Authority Autopilot | One authority job can drive a story through provider work, validation, evidence, receipt verification, and final summary. |
| M12 | Deployment And Global Verification | Postgres-backed server, key pinning, HTTPS/tunnel, global `lattice`, and full test matrix pass. |
| M13 | Proofbound Story Planner | Natural-language requests produce reviewed Story drafts, background, checklist, verification intent, assumptions, and scope questions. |
| M14 | Proofbound Job Planner | Story + verification intent produce signed Authority jobs with typed `plannedSteps[]`, policies, and planner digests. |
| M15 | Natural-Language-To-DONE E2E | `lattice planner run --mode=authority --until=DONE` creates Story/job, runs Stage B, verifies receipt, reports authority DONE or blocked, and includes source-aligned redevelopment E2E fixtures when that workflow is selected. |
| M16 | Multi-Host Final Verification | At least two independent hosts, with 2-3 hosts per review wave and optional 3+ release certification including Gemini when available, submit verifier verdicts, reconcile disagreements, and verify local or Authority final artifacts before local certified DONE or full authority DONE is claimed. |

## Current Implementation Pass

This pass should implement the missing Stage B executor loop and the Stage C
planner layer, not only document them.

### Proofbound Development Flow Binding

This product track must be built through the normal Proofbound Story flow, not as a
parallel unmanaged agent project.

Rules:

- before implementation starts, this requirements document and the requirements
  navigation entry must be tracked and committed so every implementation worktree
  receives the same truth source;
- create one parent track Story or one Story per milestone group using Proofbound
  commands only. Direct story JSON edits are not allowed;
- every implementation Story must link this document in `relatedDocs`;
- each Story checklist item must map the relevant milestone, required block, and
  Completion Criteria rows to `verificationIntent`;
- every Completion Criteria row used by a Story must produce
  `verificationEvidence` with command output, evidence refs, receipt refs, or an
  explicit blocked stop reason;
- no Story reaches DONE until `lattice validate`, global `lattice` smoke, relevant
  Stage A preflight evidence, and any required multi-host verdict evidence are
  fresh for that Story;
- final track DONE is blocked until all milestone Stories through M16 are DONE,
  the final matrix passes, and local docs are synced with the implemented
  behavior;
- the Implementation Order below is the cross-Story dependency order. Later
  Stories may start only when their prerequisite contracts and fixtures are
  available or when the Story explicitly records a blocked dependency.

### Stage A Readiness Preflight

Development may start with the first deterministic slice, but Stage B/C authority
implementation may not assume server behavior that has not been verified.

Before M6 starts, record preflight evidence for:

```bash
lattice check
npm run test:authority-receipt-classification
npm run test:authority-runner-contracts
npm run test:authority-runner-client
npm run test:authority-enforce-runner
npm run test:authority-runner-events
npm run test:authority-enforce-matrix
npm run test:authority-live-python
```

Rules:

- missing or failing preflight evidence blocks the dependent milestone Story;
- `test:authority-live-python` must prove the local Proofbound Authority server can
  satisfy the endpoint status table above, or produce exact missing endpoint
  actions;
- if the server cannot mint a verifiable native `gate_decision` receipt,
  Authority DONE implementation is blocked until that server capability is added;
- deterministic fake-provider and local executor slices may begin earlier when
  they do not depend on missing server behavior.

Implementation target:

```text
M6 Authority Job Schema
M7 Provider Executor
M8 Evidence Upload
M9 Repair And Stop Policy
M10 Gate Evaluation Loop
M11 End-To-End Authority Autopilot
M12 Final verification for the implemented path
M13 Proofbound Story Planner
M14 Proofbound Job Planner
M15 Natural-Language-To-DONE E2E
M16 Multi-Host Final Verification
```

Stage A remains a prerequisite and may receive compatibility fixes, but the
definition of success for this pass is Stage B and Stage C working end to end.

### Localhost 6789 Live Verification Plan For M1-M16

This plan creates the hard evidence needed to claim that the sixteen Authority
milestones were validated against a real local Python Proofbound Authority server at
`http://localhost:6789/`. It is a verification plan, not a second development
track.

Core rule:

```text
1. don't optimize for the sake of optimization
2. don't optimize arbitrarily
3. only fix real correctness issues
4. preserve consistency of logic
```

The live verification must preserve two user-selected operating principles:

1. **Proofbound non-authority CLI.** The client is allowed to execute locally under
   local policy, with no Proofbound Authority server contact. This mode may produce
   local evidence, local validation, and local multi-host review, but it must not
   claim `authorityDone`, `fullAuthorityDone`, server receipt verification, or
   Python Authority evidence.
2. **Proofbound CLI + Proofbound Authority.** The client is still allowed to execute
   locally, but final Authority claims require server-verified evidence from the
   Python Proofbound Authority. In this mode the local runner executes provider /
   validation work, uploads signed evidence to `http://localhost:6789/`, requests
   or verifies native `gate_decision` receipts, and uses server-backed job /
   evidence / receipt / multi-host records before claiming Authority DONE.

These principles are not interchangeable. A non-authority pass protects local
developer ergonomics; an authority pass proves the local execution was backed by
server authority evidence. The final report must show both results separately.

The verification should use six verification milestones. Six is enough because
the original sixteen milestones are development outcomes; several can be proven
by the same live run and the same evidence chain. Splitting the verification into
six milestones prevents duplicate test work while still preserving a clear
mapping from every original milestone to live localhost evidence.

Non-goals:

- do not add new product features while collecting live evidence;
- do not change the Python server API unless the live run exposes a real
  contract mismatch;
- do not replace deterministic contract, schema, or stub tests with the live
  server run. The live server run is additional hard evidence;
- do not treat `http://127.0.0.1:8765`, a stub server, or direct Pydantic schema
  validation as the final `http://localhost:6789/` proof.

Localhost live verification prerequisites:

- Python Proofbound Authority is started from
  `/Users/jek/Documents/Work/Lattice/cord-team`;
- the server listens on `http://localhost:6789/`;
- `/v1/authority/policy` returns a server key whose `publicKeyHex` is pinned in
  `LATTICE_AUTHORITY_LIVE_PUBLIC_KEY`;
- runner actor private key, runner id, session id, and project id are configured
  through environment variables or `.lattice/authority.md`;
- the live smoke output is not `SKIPPED`;
- every verification command records command, cwd, env summary with secrets
  redacted, exit code, output summary, git HEAD, and material hash.
- non-authority regression evidence proves local mode does not read
  `.lattice/authority.md`, does not connect to `http://localhost:6789/`, and
  keeps Authority flags false.

Recommended localhost server setup evidence:

```bash
cd /Users/jek/Documents/Work/Lattice/cord-team

# The default package entrypoint uses port 8765. For the final hard evidence,
# run the same app explicitly on the Proofbound local Authority default.
uv run uvicorn cord_team.api.app:create_app \
  --factory \
  --host 127.0.0.1 \
  --port 6789 \
  --ssl-keyfile <local-dev-key.pem> \
  --ssl-certfile <local-dev-cert.pem>

curl -s http://localhost:6789/health
curl -s http://localhost:6789/v1/authority/policy
```

The local certificate may be a development certificate. The Authority server key
must still be pinned and verified through `LATTICE_AUTHORITY_LIVE_PUBLIC_KEY`.
If the server cannot run on HTTPS port 6789, record that as a verification
blocker for M12 instead of downgrading the final evidence to another port.

Required Proofbound live environment:

```bash
export LATTICE_AUTHORITY_LIVE_URL=http://localhost:6789/
export LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=<policy.serverKey.publicKeyHex>
export LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=<path-to-local-test-customer-api-key>
# or: export LATTICE_AUTHORITY_CUSTOMER_API_KEY=<local-test-customer-api-key>
export LATTICE_AUTHORITY_ACTOR_ID=<runner-actor-id>
export LATTICE_AUTHORITY_ACTOR_ROLE=runner
export LATTICE_AUTHORITY_ACTOR_KEY=<runner-private-key>
export LATTICE_AUTHORITY_ACTOR_KEY_ENCODING=hex
export LATTICE_AUTHORITY_RUNNER_ID=<runner-id>
export LATTICE_AUTHORITY_SESSION_ID=<runner-session-id>
export LATTICE_AUTHORITY_PROJECT_ID=<project-id>
export LATTICE_AUTHORITY_BOOTSTRAP_TOKEN=<local-bootstrap-token-if-required>
```

For production-like local verification, also pin the server key id and reject any
default-test or ephemeral server key profile as production DONE evidence.

| Verification milestone | Covers original milestones | Purpose | Required live evidence | Pass condition |
| --- | --- | --- | --- | --- |
| V1. Local Authority boot and trust pinning | M1, M3, M12 | Prove the real Python server is reachable on the local Authority default and exposes the expected metadata. | `curl -s http://localhost:6789/health`; `curl -s http://localhost:6789/v1/authority/policy`; captured `serverKey.publicKeyHex`; pinned key comparison; server startup command and env summary. | Server is reachable on `http://localhost:6789/`, policy parses, server key is pinned, and the run is not a stub or alternate-port substitute. |
| V2. Cross-language signing and control plane | M1-M5 | Prove TypeScript and Python agree on signing, receipts, actor key registration, runner registration, heartbeat, claim, and release. | `npm run build`; `npm --prefix packages/main run test:authority-runner-contracts`; `npm --prefix packages/main run test:authority-runner-client`; `npm --prefix packages/main run test:authority-runner-events`; Python fixture/schema tests; `npm --prefix packages/main run test:authority-live-python` against `http://localhost:6789/`. | Contract tests pass and live smoke outputs `passed: policy + control-plane`, not `SKIPPED`; release uses Python `release{runnerId,sessionId,reason}` and no `outcome`. |
| V3. Stage B live execution loop | M6-M11 | Prove job schema, planned steps, provider execution, evidence upload, repair/stop policy, gate evaluation, receipt verification, and end-to-end Authority autopilot behavior while preserving local-only execution mode. | `npm --prefix packages/main run test:authority-job-loop`; `npm --prefix packages/main run test:authority-job-loop-live-smoke`; `npm --prefix packages/main run test:evidence-upload-loop-smoke`; `npm --prefix packages/main run test:evidence-live-wiring-smoke`; local/non-authority smoke proving zero server contact; live Authority evidence refs for run events, provider events, evidence upload, gate request, receipt verification, terminal status. | Non-authority execution can run locally with Authority flags false and no server contact; authority execution uploads evidence to the live server, gate receipt verification controls DONE, and failure paths release or block without dangling leases. |
| V4. Stage C planner to Authority job | M13-M15 | Prove natural-language intake can create a Story draft, checklist, verification intent, Authority job, typed `plannedSteps[]`, and both non-authority and authority execution paths. | `npm --prefix packages/main run test:planner-unattended-smoke`; `npm --prefix packages/main run test:natural-language-to-done-smoke`; local planner run evidence with zero server contact; live job creation or live job-file equivalent bound to the same Story, planner digest, checklist digest, verification intent digest, and policy. | One-sentence and document-style requests produce non-placeholder Story/job plans; unsupported scope blocks; non-authority reports local-only status; authority DONE is claimed only after verified live receipt evidence. |
| V5. Global Proofbound and deployment parity | M12 | Prove the globally installed `lattice` uses the same built code path and respects both non-authority and authority configuration. | Global `lattice check`; global local/non-authority smoke with no server contact; global `lattice authority` status/policy command where available; global `npm --prefix packages/main run test:authority-live-python` or equivalent global wrapper invocation; recorded binary realpath and package version. | Global `lattice` preserves local-only execution when non-authority is selected, and hits `http://localhost:6789/` with pinned-key verification only when authority mode is selected. |
| V6. Multi-host final certification and evidence closure | M16 plus final claim across M1-M15 | Prove final DONE is not a single-host overclaim. | Three bounded host-check waves before final DONE; each wave has at least two independent host verdicts, normally Codex CLI and Claude CLI, reviewing the same final anchors: commit/head, material hash, live smoke output, receipt refs, job/run ids, and evidence refs. Gemini may be added when available. Every wave prompt includes: `don't optimize for the sake of optimization`, `don't optimize arbitrarily`, `only fix real correctness issues`, and `preserve consistency of logic`. | Independent hosts return PASS in all three waves, or any real correctness BLOCK is repaired and the stale anchors are re-verified through fresh waves. Final claim explicitly states whether it is `localDone`, `authorityDone`, or `fullAuthorityDone`. |

Original milestone to verification milestone mapping:

| Original milestone | Verification milestone |
| --- | --- |
| M1 Contract Lock | V1, V2, V6 |
| M2 Cross-Language Crypto Fixtures | V2 |
| M3 Authority Metadata And Bootstrap | V1, V2 |
| M4 Native Receipt Verifier | V2, V3 |
| M5 Live Runner Control Plane | V2 |
| M6 Authority Job Schema | V3 |
| M7 Provider Executor | V3 |
| M8 Evidence Upload | V3 |
| M9 Repair And Stop Policy | V3 |
| M10 Gate Evaluation Loop | V3 |
| M11 End-To-End Authority Autopilot | V3 |
| M12 Deployment And Global Verification | V1, V5 |
| M13 Proofbound Story Planner | V4 |
| M14 Proofbound Job Planner | V4 |
| M15 Natural-Language-To-DONE E2E | V4 |
| M16 Multi-Host Final Verification | V6 |

Execution order:

1. Run V1 first. If HTTP `localhost:6789` cannot be started or the policy
   server key cannot be pinned, stop and fix only that correctness blocker.
2. Run V2 after V1 passes. V2 proves the live control plane and the
   cross-language body shapes before any higher-level DONE claim.
3. Run V3 with at least one no-job control-plane path and one claimed-job path.
   If the live server cannot issue or verify the required gate receipt, stop at
   blocked M10/M11 instead of claiming Authority DONE.
4. Run V4 only after V3 proves the executor can consume a live Authority job.
5. Run V5 to prove the global binary is not stale and does not secretly use a
   package-local `bin/lattice.js` path.
6. Run V6 last. If any verifier finds a real blocker, repair the blocker and
   rerun the affected verification milestone plus V6.

Minimum final evidence bundle:

- command transcript for each V1-V6 command;
- non-authority CLI transcript proving local execution succeeds without server
  contact and without Authority DONE flags;
- Python server startup command, URL, and policy response digest;
- pinned server public key and key id;
- customer key id/source status, actor id, runner id, session id, project id,
  and key source summary with private material redacted;
- live job id, run id, receipt id, and evidence refs when a job is claimed;
- explicit proof that `test:authority-live-python` did not skip;
- global `lattice` binary realpath/version;
- three bounded host-check wave summaries, with at least two independent host
  verdict artifacts per wave and the four required review principles recorded
  in each wave prompt digest;
- final status object distinguishing `localDone`, `authorityDone`,
  `fullAuthorityDone`, `receiptVerified`, and `multiHostVerified`.

Fail-closed rules:

- a non-authority pass cannot be promoted to Authority DONE;
- an authority run without server evidence cannot be reported as
  `authorityDone`;
- alternate-port evidence is useful diagnostic evidence but does not satisfy the
  final localhost 6789 claim;
- stub evidence proves deterministic behavior but does not satisfy live
  Authority evidence;
- schema-only evidence proves body shape but does not satisfy server
  reachability;
- if a repair changes code, policy, docs, server config, or material hash, rerun
  the affected verification milestone and then V6;
- if a proposed change is only an optimization, style cleanup, or unrelated
  hardening, defer it to a follow-up Story.

### Twenty-Five Required Blocks For This Pass

The following twenty-five blocks are mandatory for this implementation pass.
They are not optional enhancements. If any block is missing, Proofbound must not
claim full unattended development mode.

1. **Authority job producer and schema.**
   Proofbound Authority must dispatch jobs that include `plannedSteps[]`, retry
   policy, stop policy, lease metadata, evidence policy, provider policy, and
   receipt policy, and multi-host policy. The claimed job payload must be
   complete enough that the runner does not guess what to do.

2. **Stage B executor loop.**
   `lattice autopilot execute --mode=authority` must claim an authority job,
   consume `plannedSteps[]`, execute typed steps, heartbeat, renew leases,
   upload evidence, retry or repair when policy allows, and release or complete
   the job.

3. **Provider executor.**
   The executor must support `provider.fake` for deterministic E2E,
   `provider.codex` for real bounded development, and `provider.claude` behind
   an explicit enable flag. All providers must run in the authoritative story
   worktree and must capture structured execution evidence.

4. **Evidence upload loop.**
   The executor must upload provider events, command events, validation
   evidence, git evidence, gate requests, and stop summaries to Proofbound
   Authority. Local logs alone are not sufficient.

5. **Validation, repair, retry, and safe stop.**
   Validation failure must trigger a configured repair/retry path or a clear
   blocked stop. Provider timeout, repeated no-progress, receipt failure, dirty
   unrelated worktree, and unsafe lease state must all stop safely with an
   uploaded or locally printed final summary.

6. **Gate evaluation and receipt verification.**
   The executor must automatically call `/v1/gates/evaluate`, fetch or receive a
   native `gate_decision` receipt, verify project/story/kind/server key id,
   `decisionDigest`, freshness when enabled, and Ed25519 signature, then fail
   closed on any mismatch.

7. **End-to-end verification matrix.**
   The pass must prove fake provider happy path, fake validation failure repair,
   gate rejection, tampered receipt rejection, Codex provider happy path, Codex
   timeout handling, dirty worktree protection, local/shadow autopilot
   regression, and global `lattice` execution.

8. **Proofbound Story Planner.**
   Proofbound must turn a natural-language request into a reviewed Story draft with
   background, checklist, verification intent, assumptions, scope questions,
   risk classification, related docs, and source-aligned redevelopment
   workflow intent. Story creation must use Proofbound commands only.

9. **Proofbound Job Planner.**
   Proofbound must turn Story + verification intent into a signed Authority job
   with typed `plannedSteps[]`, retry policy, stop policy, evidence policy,
   receipt policy, provider policy, worktree policy, and planner digests.

10. **Natural-language-to-DONE E2E.**
    The pass must prove `lattice planner run --request=... --mode=authority
    --until=DONE` can create the Story, create the Authority job, run Stage B,
    verify the native receipt, and report authority DONE or blocked according to
    gate outcome.

11. **One-sentence and paragraph request intake.**
    The planner must accept both inline one-sentence/paragraph requests and
    multi-paragraph `--requestFile` input. It must hash the original request,
    preserve materially important wording in evidence, and normalize both forms
    into the same planner schema.

    Source-aligned redevelopment workflow intake must also accept an authorized
    source codebase ref, target project path/name, source/target language ids,
    rename map, redevelopment scope, language adapter policy, semantic mapping
    policy, and parity oracle policy without treating redevelopment as a fourth
    interaction mode.

12. **Structured planner output gate.**
    Planner output must be schema-validated JSON with no placeholders, complete
    verification intent, explicit assumptions, and explicit blocked questions
    for high-risk ambiguity.

13. **Story lifecycle bootstrap.**
    Natural-language-to-DONE must create or reuse the Story, materialize
    checklist and verification intent, advance through required lifecycle gates,
    create or resolve the story worktree, and enter the legal execution phase
    before provider work starts.

14. **Checklist-to-evidence coverage binding.**
    Every checklist item must map to verification intent, planned steps,
    validation steps, evidence refs, expected artifacts, and gate predicates.
    Missing coverage fails authority DONE.

15. **DONE reconciliation and cleanup.**
    Final DONE must reconcile local lifecycle, Authority receipt, Authority job
    completion, lease state, worktree safety, and final summary. Any missing link
    produces blocked/failed, not authority DONE.

16. **Resume, idempotency, and duplicate prevention.**
    Request, planner draft, Story creation, job creation, evidence upload, gate
    evaluation, and job completion must have idempotency keys or digests so
    reruns do not create duplicate Stories/jobs or conflicting evidence.

17. **Budget, timeline, and audit output.**
    The run must respect planner/executor budgets and output an audit timeline
    from request intake through planner, story, job, step execution, evidence,
    receipt verification, and final status.

18. **Planner interaction modes.**
    The planner must support `autonomous`, `interview`, and `decision-gated`.
    `autonomous` runs without confirmation and blocks unsafe ambiguity;
    `interview` asks 5-10 detailed questions and requires one confirmation;
    `decision-gated` pauses only for major decisions and records decision
    receipts before continuing.

19. **Anti-over-optimization gate.**
    Planner, executor, and reviewers must reject unnecessary scope expansion,
    speculative abstractions, unrelated refactors, and optimization work that is
    not required by the user request, verification intent, lifecycle gate,
    evidence requirement, or safety policy.

20. **Multi-host final verification.**
    Final certification must include three bounded host-check waves before final
    DONE. Each required review wave includes at least two independent host
    verdicts, normally targeting 2-3 hosts and optionally preferring 3+ hosts
    such as Codex, Claude Code, and Gemini for release certification. One host
    may implement; the others must independently verify the relevant local
    anchors or Story/job/evidence/receipt artifacts and issue structured
    pass/fail/blocked verdicts. Each wave prompt carries the four principles:
    `don't optimize for the sake of optimization`, `don't optimize arbitrarily`,
    `only fix real correctness issues`, and `preserve consistency of logic`.

21. **Question, decision, and resume I/O.**
    `interview` and `decision-gated` modes must be drivable through structured
    CLI inputs (`planner answer`, `planner decision submit`, and
    `planner resume`) so E2E tests can prove the pause/resume path without an
    unstructured chat transcript.

22. **Policy, resolver, and freshness contracts.**
    `plannerPolicy`, `providerPolicy`, `worktreePolicy`, receipt freshness, and
    Story/worktree resolver behavior must be named and schema-validated so
    planner, executor, and Authority server do not guess.

23. **Planner/executor step compatibility.**
    Job Planner output must use only B1 allowlisted step types, and B10 must
    expose the bindings the executor needs for provider, validation, repair, and
    evidence handling.

24. **Credential and evidence lifecycle.**
    Provider credentials must be sourced only through allowed local policy or
    secret refs, never uploaded. Evidence storage, redaction, retention, and
    garbage collection rules must preserve verification while preventing secret
    leakage and unbounded log growth.

25. **Verdict submission and reconciliation.**
    Multi-host verifier verdicts must have a command/API submission path,
    persisted records, independent-host counting, and a disagreement protocol
    that blocks local review certification or full authority DONE, or returns to
    repair when policy and budget allow. Any repair that changes material state
    must trigger fresh validation and a fresh review wave; Authority mode must
    also obtain a fresh verified receipt before the new review wave.

### Implementation Pass Deliverables

Proofbound CLI deliverables:

- `lattice planner draft` produces a structured Story draft from a
  natural-language request.
- `lattice planner draft --requestFile=<file>` supports multi-paragraph
  requirement text.
- `lattice planner draft/run --interactionMode=autonomous|interview|decision-gated`
  selects the user participation policy.
- `lattice planner answer`, `lattice planner decision submit`, and
  `lattice planner resume` drive paused planner runs through structured files.
- `lattice planner review` rejects ambiguous, placeholder, overbroad, unsafe, or
  unverifiable drafts.
- `lattice planner create-story` creates Story artifacts through Proofbound
  commands only.
- `lattice story resolve --storyId=<story> --json` or its internal resolver
  equivalent provides the authoritative worktree cwd.
- `lattice planner create-job` submits a signed Authority job with typed
  `plannedSteps[]`.
- `lattice planner create-job` output includes the `jobCreateRequestEnvelope`
  digest, idempotency key, actor key id, signature status, and server acceptance
  or rejection reason.
- `lattice planner run --mode=local --until=DONE --requireMultiHost` composes
  Story Planner, a local run plan, local executor, validation, and local review
  certification without using Authority receipts.
- `lattice planner run --workflow=source-aligned-redevelopment` produces a
  source-aligned redevelopment Story, local run plan or Authority job,
  source/target language adapter evidence, rename-map evidence, and alignment
  verification intent.
- `lattice planner run --mode=authority --until=DONE` composes Story Planner,
  Job Planner, and Stage B executor when policy allows unattended planning.
- `lattice planner run --forceNewRun --forceNewRunReason=<reason>` creates a
  distinct planner run only when policy allows it.
- `lattice autopilot execute --mode=authority` consumes an authority job instead
  of only projecting readiness.
- `lattice autopilot execute --mode=authority` reads `LATTICE_AUTHORITY_URL`,
  `LATTICE_AUTHORITY_*` key env vars, or `.lattice/authority.md` according to the
  configured precedence, defaulting to `http://localhost:6789/` only for local
  authority development.
- `lattice autopilot execute --mode=local --until=DONE --requireMultiHost`
  records local evidence and may report `localReviewCertified=true`, but must
  keep `authorityDone=false`, `fullAuthorityDone=false`, and
  `multiHostVerified=false`.
- `lattice autopilot review submit/status` records and reports local verifier
  verdicts keyed by `storyId` and local `runId`.
- The executor reads `plannedSteps[]` and executes typed steps in order.
- The executor supports `provider.fake` for deterministic E2E tests.
- The executor supports `provider.codex` for real bounded provider execution.
- `provider.claude` is implemented behind an explicit enable flag and local
  policy gate.
- Provider credentials are sourced only through allowlisted local policy or
  secret refs and are never copied into prompts, evidence, or job metadata.
- Step execution captures stdout/stderr digests, exit code, duration, cwd,
  before/after git status, and material hash.
- Evidence upload APIs are called for run records, provider events, command
  events, validation evidence, git evidence, gate requests, and stop summaries.
- Retry, repair, timeout, no-progress, dirty-worktree, and receipt-failure paths
  are implemented as explicit result classifications.
- Gate evaluation is called automatically when the job target requires TEST or
  DONE authority.
- Native `gate_decision` receipt verification gates authority DONE.
- Final JSON reports `localDone`, `authorityDone`, `receiptVerified`,
  `localReviewCertified`, `fullAuthorityDone`, `multiHostVerified`, host verdict
  counts, review wave refs, `receiptId`, `decisionDigest`, executed steps,
  evidence refs, stop reason, and next action.
- Final JSON also reports planner ids/digests, created/reused story and job ids,
  checklist coverage, idempotency keys, budget usage, and timeline entries.
- Final JSON reports receipt freshness decisions, provider fallback decisions,
  redaction summaries, and whether a run was forced new.
- Final JSON reports selected development mode, interaction mode, and
  `developmentWorkflow` when present.
- Source-aligned redevelopment final JSON reports source/target manifest
  digests, source/target language ids, source/target adapter digests, alignment
  map refs, rename-map digest, target-runnable parity refs, license notice refs,
  and gap list refs.
- Planner/final summary reports deferred optimizations when useful and confirms
  they are not required for DONE.
- Final JSON includes multi-host verdict records and blocks local review
  certification or full authority DONE when fewer than the required independent
  host verdicts pass.
- Final JSON blocks local review certification or full authority DONE on
  multi-host disagreement unless the disagreement was repaired, fresh validation
  and a fresh receipt were produced when required, and fresh verifier verdicts
  pass.
- Final JSON distinguishes per-run receipt-backed `authorityDone` from
  multi-host-certified `fullAuthorityDone` and local `localReviewCertified`.

Proofbound Authority deliverables:

- Job payloads include typed `plannedSteps[]`, retry policy, stop policy,
  evidence policy, receipt policy, provider policy, worktree policy,
  multi-host policy, and lease metadata.
- Job records bind planner digests, story id, verification intent digest, and
  planned step digests.
- Job claim returns enough data for Proofbound CLI to execute without guessing.
- Job heartbeat, lease renewal, release, and completion are idempotent.
- Evidence endpoints accept the executor evidence classes required by this
  document.
- Evidence storage tracks redaction state, retention class, artifact refs, and
  receipt-bound retention.
- Gate evaluation accepts the executor's gate input digest and returns or links
  a native signed `gate_decision` receipt.
- Run and provider-event records are queryable for audit.
- Multi-host verdict endpoints accept and list verifier verdict records.
- Multi-host verdict endpoints authenticate submitters and count independence
  from authenticated host/session/key binding, not self-reported JSON fields.
- Authority policy exposes `plannerPolicy`, `providerPolicy`, `worktreePolicy`,
  receipt freshness, and multi-host verification requirements.

Shared deliverables:

- A deterministic planner fixture proves natural-language request to Story draft
  without provider execution.
- A deterministic job planner fixture proves Story draft to typed
  `plannedSteps[]` and Authority job payload.
- The job planner fixture proves all generated step types are in the B1
  allowlist and that B10 bindings are present when validation, repair, provider,
  or evidence behavior depends on them.
- A deterministic fake-provider E2E fixture proves the executor loop without
  relying on model behavior.
- A real Codex provider E2E proves that a bounded provider can modify a story
  worktree, validation can run, evidence can upload, and a receipt can gate
  DONE.
- Negative fixtures prove gate rejection, tampered receipt, wrong key, wrong
  story, validation failure, provider timeout, and no-progress stop.
- Public docs and CLI help are updated only when implementation lands. README,
  `docs/guide.md`, and command help must distinguish current local projection
  behavior from the new Authority job consumer behavior without overclaiming
  Authority DONE.

### Implementation Order For This Pass

1. **Job schema and fake provider first.**
   Implement typed job parsing and `provider.fake` before real model execution.
   This gives deterministic tests for claim, step execution, evidence upload,
   validation, gate evaluation, receipt verification, completion, and release.

2. **Executor state machine.**
   Implement the runtime statuses from B8 and the step lifecycle from B11. The
   executor must emit state transitions in JSON and evidence records.

3. **Evidence upload loop.**
   Wire run records, provider events, command events, validation evidence, git
   evidence, gate requests, and stop summaries. Evidence upload failures must be
   classified, retried, and respected by the stop policy.

4. **Validation and repair loop.**
   Implement validation as a separate step. Add repair attempts and no-progress
   detection before enabling real providers.

5. **Gate evaluation and receipt verification.**
   Implement automatic `/v1/gates/evaluate`, receipt fetch when needed, native
   receipt verification, and hard fail-closed behavior on mismatch.

6. **Real Codex provider.**
   Add bounded Codex execution after fake-provider E2E passes. Codex output must
   still go through evidence upload and validation before any gate request.

7. **Claude provider behind flag.**
   Add Claude Code CLI only after Codex/fake paths are stable. It must use the
   same timeout, cwd, evidence, and stop semantics.

8. **Global CLI and deployed-authority verification.**
   Rebuild global `lattice`, run the local and live smoke matrix, then run the
   deployment-grade pinned-key verification.

9. **Story Planner.**
   Implement `planner draft`, `planner review`, and `planner create-story` after
   the executor's typed step contract is stable. The planner must produce drafts
   that map directly to Proofbound Story fields and verification intent.

10. **Job Planner.**
    Implement `planner create-job` after Stage B can consume typed
    `plannedSteps[]`. This avoids generating job shapes the executor cannot run.

11. **Natural-language-to-DONE composition.**
    Implement `planner run` after Story Planner, Job Planner, and Stage B E2E
    each pass independently. This command composes already-tested pieces rather
    than creating a second executor.

### Completion Criteria For This Pass

This pass is complete only when all of these cases pass:

| Case | Required result |
| --- | --- |
| fake provider happy path | authority job reaches target and releases/completes cleanly. |
| fake provider validation failure | repair or blocked stop is deterministic and evidenced. |
| fake provider gate rejection | no authority DONE, job stops blocked with decision summary. |
| fake provider tampered receipt | no authority DONE, receipt failure is explicit. |
| Codex provider happy path | bounded provider execution, validation, evidence upload, receipt verification pass. |
| Codex provider timeout | retry or blocked stop according to policy. |
| provider unavailable | fail closed with `provider_unavailable`, record reason, and release lease. |
| credential unavailable | missing configured provider credential blocks with `credential_unavailable`; no secret is requested or uploaded. |
| evidence redaction fixture | secret-like content is redacted before upload while digests remain verifiable. |
| evidence retention fixture | receipt-bound evidence is retained; expired short-lived logs can be garbage-collected without losing final verification. |
| evidence idempotency collision fixture | multiple same-kind evidence records in one step attempt have distinct idempotency keys. |
| dirty worktree protection | unrelated user changes are preserved; unsafe job stops. |
| stale receipt freshness | stale enforce-mode receipt fails authority DONE. |
| future receipt clock skew | future-dated receipt beyond `LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS` fails with explicit reason. |
| local autopilot regression | local mode still works without Proofbound Authority. |
| local review certified | local mode with `--requireMultiHost` reaches `localReviewCertified=true` only after required independent local verdicts pass. |
| local review overclaim guard | local review never sets `authorityDone`, `fullAuthorityDone`, or `multiHostVerified`. |
| shadow autopilot regression | shadow mode still warns only. |
| global `lattice` | global binary runs the same authority/autopilot smoke path. |
| status commands | `planner status` and `authority job status` are read-only and match run/job state. |
| story resolver | `lattice story resolve --storyId=<story> --json` returns the authoritative cwd before provider work. |
| planner draft fixture: one sentence | inline one-sentence request produces Story draft with no placeholders. |
| planner draft fixture: paragraph | inline paragraph request produces Story draft with preserved request digest. |
| planner draft fixture: request file | multi-paragraph `--requestFile` produces Story draft with preserved request digest. |
| planner omitted interaction mode | defaults to `autonomous` and reports that default in JSON. |
| planner autonomous mode | no confirmation is requested; unsafe ambiguity blocks. |
| planner interview mode | asks 5-10 detailed questions, records structured answers through `planner answer`, requires one confirmation, and resumes. |
| planner decision-gated mode | pauses only for major decisions, records structured decisions through `planner decision submit`, and resumes. |
| planner paused state | paused planner run exits safely and resumes from persisted state. |
| planner unattended policy denied | `allowUnattendedPlanning=false` stops after draft/review instead of creating Story/job. |
| force new run | `--forceNewRun` requires policy allowance and reason, then creates a distinct idempotency scope. |
| planner review negative | vague/overbroad/unverifiable request blocks with scope questions. |
| planner anti-over-optimization | unnecessary refactor/optimization is deferred, not added to planned steps. |
| development flow binding | implementation Stories link this document, map milestone/block/completion rows to `verificationIntent`, record `verificationEvidence`, and block final track DONE until M16 evidence passes. |
| Stage A readiness preflight | required Authority preflight commands pass or block dependent milestone Stories with exact missing server actions. |
| server endpoint status table | each Authority endpoint has `existing` / `partial` / `missing` status before M6, and `gate_decision` receipt minting is explicitly confirmed or blocks Authority DONE work. |
| signed job creation envelope | `planner create-job` submits a signed envelope binding Story, planner, planned steps, policies, idempotency key, actor key, and canonical digest; invalid signature/digest/idempotency fails before job visibility. |
| redevelopment supported pair matrix | `source-aligned-redevelopment` runs at least two materially different language pairs through the same workflow/evidence schema; every policy-claimed supported pair must pass the same fixture. |
| redevelopment pair-agnostic plan shape | planned steps use only B1 allowlisted root types; pair differences appear only in adapter ids, structured args, and evidence refs. |
| redevelopment policy schema invalid | missing or invalid adapter, semantic mapping, parity oracle, or alignment verification policy blocks before Story/job/provider/target mutation. |
| redevelopment neutral manifest semantic map | source/target neutral manifests and `1:1` / `1:N` / `N:1` / `mapped_to_gap` alignment maps are backed by deterministic command evidence, not provider prose. |
| redevelopment target-runnable parity | required behavior has target-runnable build/test/CLI/API/golden/serialization/error/side-effect evidence before DONE can be claimed. |
| redevelopment source-only untranslatable no-loop | source-only behavior records `gapList[]` or `source_only_untranslatable` blocked stop without consuming repair attempts for that item. |
| redevelopment missing adapter block | missing source or target adapter stops with `adapter_unavailable` before provider execution and target mutation unless scoped-gap policy is explicit. |
| redevelopment license and secret negative | required notices are preserved or block, and source secrets / `.git` / caches / env files are excluded or redacted according to policy. |
| job planner fixture | Story + verification intent produce typed `plannedSteps[]`. |
| job planner step compatibility | generated `plannedSteps[]` use only B1 allowlisted step types and include B10 bindings where needed. |
| provider/worktree policy schema | job schema validates `providerPolicy`, `worktreePolicy`, `retryPolicy`, `stopPolicy`, `lease`, `evidencePolicy`, `receiptPolicy`, and `multiHostPolicy`; invalid fallback/worktree policy is rejected. |
| story lifecycle bootstrap | planner-created Story reaches legal execution phase/worktree before provider work. |
| checklist coverage binding | every checklist item maps to verification intent, planned steps, evidence, and gate predicate. |
| duplicate request idempotency | rerunning same request reuses or references existing draft/story/job. |
| crash/resume safety | interrupted run resumes from safe state or releases lease and stops non-authority. |
| budget exceeded | planner/executor stops blocked with budget usage and next action. |
| DONE reconciliation mismatch | local DONE without receipt or receipt without legal local advance does not claim authority DONE. |
| audit timeline | final JSON includes planner/story/job/step/evidence/receipt/final-status timeline. |
| natural-language-to-DONE fake provider | `planner run` reaches authority DONE or blocked through the full chain. |
| natural-language-to-DONE Codex provider | `planner run` with Codex executes bounded development and verifies receipt. |
| public docs sync | README, guide, and CLI help describe implemented local/authority behavior truthfully and do not overclaim Authority DONE. |
| multi-host final verification | three bounded host-check waves pass before final DONE; each wave has at least two independent host verdicts, e.g. Codex and Claude Code with Gemini available as a preferred verifier, verifying the same local anchors or final Story/job/evidence/receipt chain for that wave. |
| multi-host target wave | policy can request 2-3 hosts per wave and prefer 3+ release certification, including Gemini when registered and available. |
| multi-host verdict authenticity | Authority counts independent hosts from authenticated host/session/key binding, not self-reported JSON fields. |
| multi-host ordering | receipt is issued and verified before host verdicts; `fullAuthorityDone` waits for multi-host pass. |
| multi-host verdict submit | second host submits verdict through CLI/API and `authority job status` reflects it. |
| multi-host disagreement | failing independent verdict blocks local review certification or full authority DONE, or returns to repair when policy and budget allow. |
| multi-host repair freshness | repair that changes material state forces fresh validation, fresh Authority receipt when applicable, and a fresh review wave. |

After these pass, Proofbound can claim:

```text
Proofbound natural-language-to-authority-DONE unattended development v1 is implemented.
```

Before these pass, Proofbound may only claim:

```text
Stage A authority control plane is connected, and Stage B/Stage C are in progress.
```

## Agent Plan

Recommended staffing: three host runtimes with bounded, wave-based concurrency:

- **Codex CLI host:** one coordinator plus a 3-6 agent review/confirmation pool.
  The review pool is event-triggered for contract lock, high-risk gates, final
  review, and release certification; it is not a standing per-step review loop.
- **Claude CLI host:** primary implementation host for server/CLI/provider work.
- **Gemini CLI host:** independent implementation or verifier host when available,
  especially for cross-checking plans, final verification, and bounded parallel
  implementation lanes.

Default active implementation concurrency is six agents plus one Codex
coordinator, matching the milestone ownership below. A temporary 13-15 agent
burst is allowed only when all of these are true:

- Stage A readiness preflight has passed or the burst is limited to preflight
  remediation Stories;
- each agent owns a separate Proofbound Story or non-overlapping write-set;
- every Story has explicit `relatedDocs`, `verificationIntent`, and validation
  rows before implementation starts;
- no shared contract file is edited by multiple agents without the Codex
  coordinator sequencing the changes;
- the burst is time-boxed to the current wave and ends before final certification.

More agents on the same host/session do not increase independent-host
verification. Multi-host verification counts host/session/key/provider
independence, not raw agent count.

| Agent | Scope | Milestones |
| --- | --- | --- |
| Agent 1 | Python Authority API, config, deployment, receipts. | M3, M8, M10, M12 |
| Agent 2 | Crypto contracts, fixtures, native verifier review. | M2, M4, M10 |
| Agent 3 | Runner registry, job scheduler, leases, completion semantics, Authority job schema. | M5, M6, M11, M14 |
| Agent 4 | Proofbound CLI autopilot executor, command policy, Job Planner integration. | M5, M7, M9, M11, M14 |
| Agent 5 | Provider adapters, worktree safety, evidence capture, Story Planner implementation. | M7, M8, M9, M13 |
| Agent 6 | E2E smokes, docs, deployment verification, overclaim audits, natural-language-to-DONE verification, multi-host final verification. | M1, M11, M12, M15, M16 |
| Codex coordinator | Sequence, merge local work, prevent contract drift, run final matrix. | all |

## Parallelization Plan

Wave 1: contract and cryptographic foundation.

- Agent 1 confirms current Python endpoint behavior.
- Agent 2 builds shared signing fixtures.
- Agent 6 rewrites docs and validation matrix.
- Coordinator freezes contracts and reviews naming.

Wave 2: Stage A implementation.

- Agent 1 updates Python metadata and bootstrap security.
- Agent 2 implements / reviews native verifier tests.
- Agent 3 confirms runner claim and release semantics.
- Agent 4 wires live runner client.
- Agent 6 runs overclaim tests.

Wave 3: Stage B executor.

- Agent 3 finalizes job schema and scheduler behavior.
- Agent 4 implements authority executor loop.
- Agent 5 implements provider and evidence capture.
- Agent 1 implements evidence and gate receipt server refinements.

Wave 4: Stage C planner.

- Agent 5 implements Story Planner draft/review/create-story.
- Agent 4 implements Job Planner and `planner create-job`.
- Agent 3 ensures Authority job records bind planner and step digests.
- Agent 6 adds planner fixtures and negative tests.

Wave 5: end-to-end, multi-host verification, and deployment.

- Agent 6 owns the full smoke matrix.
- Codex host and Claude Code host both issue independent final verdict records;
  Gemini may be added as a preferred third verifier when registered and
  available.
- Coordinator reconciles any host disagreement before local review certification
  or full authority DONE is claimed.
- Agent 1 verifies Postgres / Alembic / deployed server behavior.
- Coordinator runs global build, global `lattice`, and final regression matrix.

## Validation Matrix

### Local And Shadow Modes

| Case | Expected |
| --- | --- |
| local autopilot without Proofbound Authority | pass |
| non-authority no server contact | local/non-authority mode does not read `authority.md`, connect to `http://localhost:6789/`, or call Authority endpoints |
| local validation failure | returns local failure, no authority overclaim |
| local multi-host review | required independent local verdicts set `localReviewCertified=true` |
| local multi-host overclaim guard | local review keeps `authorityDone=false`, `fullAuthorityDone=false`, and `multiHostVerified=false` |
| local duplicate host rejection | duplicate same-host or same-session verdicts do not satisfy local review certification |
| shadow mode without server | warning only |
| shadow mode with server failure | warning only |
| local/shadow status | `productionDone=false`, `receiptVerified=false` |

### Authority Readiness

| Case | Expected |
| --- | --- |
| missing `LATTICE_AUTHORITY_URL` | fail closed in authority mode |
| omitted Authority URL in local authority dev | defaults to `http://localhost:6789/` only in authority mode |
| production Authority URL omitted | fail closed instead of silently using localhost |
| authority.md key file | reads server URL, project id, customer key ref, actor id/key id, server key id/public key, and actor key ref from `.lattice/authority.md` |
| authority.md precedence | explicit CLI/env settings override `.lattice/authority.md`; missing required values fail closed |
| default test key in production | default test key is rejected for deployed production Authority DONE |
| missing actor key | fail closed in authority mode |
| missing customer API key in production authority mode | fail closed before actor enrollment or mutating Authority calls |
| wrong / revoked / expired customer API key | fail closed with a customer-key blocker, not an actor-signature blocker |
| customer key for another project | actor enrollment, evidence upload, gate evaluation, and verdict submission reject the request |
| missing runner id | fail closed in authority mode |
| missing project id | fail closed for live runner/jobs |
| policy server key discovered | pass metadata parse |
| pinned key mismatch | fail |

### Signing And Receipts

| Case | Expected |
| --- | --- |
| Python signs actor envelope, Node verifies | pass |
| Node signs actor envelope, Python verifies | pass |
| Python signs receipt, Node verifies | pass |
| tampered payload | fail |
| wrong project/story/kind/key | fail |
| missing `decisionDigest` for DONE | fail |
| legacy subject receipt for native DONE | fail |
| stale enforce-mode receipt | fail with freshness reason |
| future-dated enforce-mode receipt | fail when beyond allowed clock-skew tolerance |
| invalid clock skew policy | negative or over-policy skew fails configuration validation |

### Runner And Jobs

| Case | Expected |
| --- | --- |
| register actor key in development | pass |
| production registration missing required bootstrap token | fail when server policy requires bootstrap enrollment |
| live runner no job | pass/no-job |
| live runner jobs stream available hint | positive `jobs.available` SSE is recorded as `jobs_stream` and the runner still uses signed claim; the hint is not a separate ownership or provider-authorization API |
| live runner jobs stream empty/error/timeout/malformed | record diagnostic `jobs_stream` fallback and continue to signed claim |
| live runner claims no-provider job | release immediately |
| live runner claims executable job | executor starts bounded loop |
| stale lease | fail or renew according to policy |
| lease shape | claimed job includes `leaseId`, runner/session ids, expiry, TTL, renewal threshold, grace, and version |
| release on stop | pass |
| job policy schema | `providerPolicy`, `worktreePolicy`, `retryPolicy`, `stopPolicy`, `evidencePolicy`, `receiptPolicy`, `multiHostPolicy`, lease, and planner digests validate |
| verdict endpoint | verifier verdict submit/list endpoints persist records |
| verdict authentication | Authority independence count uses authenticated host/session/key binding |
| evidence/gate/verdict dual credentials | evidence upload, gate evaluation, and verdict submission require both customer API key authorization and a valid actor signature |

### Executor

| Case | Expected |
| --- | --- |
| fake provider happy path | TEST/DONE loop reaches expected target |
| real Codex provider happy path | evidence uploaded, validation runs |
| real Claude provider enabled | evidence uploaded, validation runs |
| provider timeout | retry or blocked stop |
| provider unavailable | blocked with provider reason and clean lease release |
| provider credential unavailable | blocked without prompting for or uploading secrets |
| evidence redaction | secrets are not uploaded; redacted refs and digests remain |
| evidence retention | receipt-bound artifacts are retained; expired short-lived logs can be deleted |
| evidence idempotency | same step/attempt/kind records remain distinct by sequence or content digest |
| validation failure | repair or return to DEV according to policy |
| dirty unrelated worktree | stop or preserve according to policy |
| story resolver | authoritative cwd is resolved before provider execution |
| gate receipt verification failure | stop, no DONE |
| successful gate receipt | authority DONE projection allowed |

### Planner And Natural-Language-To-DONE

| Case | Expected |
| --- | --- |
| one-sentence request | planner draft passes with request digest and no placeholders |
| paragraph request | planner draft preserves intent and produces one focused Story |
| multi-paragraph `--requestFile` | planner decomposes or blocks when scope is too broad |
| omitted interaction mode | defaults to `autonomous` and reports defaulted mode in JSON |
| autonomous interaction mode | no user confirmation is requested; policy-allowed high-risk ambiguity uses host decision evidence, unresolved ambiguity stops blocked |
| interview interaction mode | 5-10 detailed questions are asked, `planner answer` records answers, one confirmation is required, and resume works |
| decision-gated interaction mode | only major decisions pause the run, `planner decision submit` records decisions, and resume works |
| paused planner run | CLI exits with persisted paused state and resumes without in-memory dependency |
| unattended planning denied | policy-denied run stops after draft/review before Story/job creation |
| force new run | policy-allowed `--forceNewRun` creates distinct idempotency scope with reason |
| source-aligned redevelopment intake | `--workflow=source-aligned-redevelopment` requires authorized source ref, target path/name, canonical source/target language ids, rename map, redevelopment scope, adapter policy, semantic mapping policy, and parity oracle policy |
| redevelopment language abstraction intake | `--workflow=source-aligned-redevelopment` records canonical `sourceLanguage`, `targetLanguage`, adapter policy, semantic mapping policy, and parity oracle policy without creating pair-specific workflows |
| redevelopment is not interaction mode | source-aligned redevelopment runs under `autonomous`, `interview`, or `decision-gated` without adding a fourth interaction mode |
| redevelopment source read-only | source repo is not mutated and excluded paths are honored |
| redevelopment source budget | source file/byte/module/function/alignment-pass limits block oversized runs before token exhaustion |
| redevelopment adapter resolution | source and target language adapters resolve to adapter digests before provider execution, or the run blocks / records scoped gaps according to policy |
| redevelopment neutral manifests | source and target extraction produce language-neutral manifest records with module, symbol, kind, signature-shape, runtime boundary, confidence, and source location when available |
| redevelopment deterministic alignment | module/function alignment maps come from manifest extraction and command results, not provider prose |
| redevelopment cross-language mapping | alignment maps support `1:1`, `1:N`, `N:1`, and `mapped_to_gap` entries with mapping rationale for target-language idioms |
| redevelopment target-runnable parity | behavior parity checks run against the target project or record explicit gaps for source-only behavior; untranslatable checks do not enter repeated repair loops |
| redevelopment alignment evidence | module/function alignment maps, rename-map digest, target-runnable build/test/parity refs, license refs, and gap list are produced |
| redevelopment license preservation | required notices are preserved or the run blocks |
| redevelopment secret exclusion | source secrets, credentials, caches, `.git`, generated outputs, and env files are not copied into target, prompts, or evidence |
| planner status | read-only status shows request digest, mode, Story/job ids, phase, decisions, evidence, receipt, and final status |
| vague request | planner review blocks with `scopeQuestions[]` |
| autonomous host decision wave | high-risk ambiguity uses 2-3 host structured decision evidence and resumes only if resolved |
| interview host decision wave | post-confirmation high-risk ambiguity uses 2-3 host structured decision evidence and resumes only if resolved |
| anti-over-optimization request | planner defers unnecessary optimization and keeps Story scope minimal |
| Story lifecycle bootstrap | Story reaches legal execution phase before provider work |
| checklist coverage | every checklist item has verification intent, planned steps, evidence, and gate predicate |
| planned step allowlist | Job Planner emits only B1 allowlisted root step types |
| planned step bindings | B10 provider/validation/repair/evidence bindings are parsed and honored |
| duplicate request | rerun reuses or references existing draft/story/job |
| crash/resume | resumes safely or releases lease and stops non-authority |
| DONE reconciliation mismatch | missing local DONE or missing receipt prevents authority DONE |
| audit timeline | final JSON contains request/planner/story/job/step/evidence/receipt/final status timeline |
| multi-host final verification | three bounded host-check waves pass before final DONE; Codex and Claude Code, or registered independent hosts with Gemini available as a preferred verifier, verify the same local anchors or Authority final artifacts in each wave |
| multi-host target wave | review policy supports 2-3 hosts per wave and preferred 3+ release certification with Gemini as a verifier host when available |
| multi-host duplicate host rejection | duplicate same-host or same-session verdicts do not satisfy independent-host DONE |
| multi-host disagreement | failing independent verdict blocks local review certification or full authority DONE, or triggers bounded repair and fresh verdicts |
| multi-host fresh wave after repair | repair that changes material state forces fresh validation, fresh receipt in Authority mode, and fresh verifier verdicts |
| authority vs full DONE fields | final JSON distinguishes `authorityDone` from `fullAuthorityDone` and reports `multiHostVerified` |

### Deployment

| Case | Expected |
| --- | --- |
| Postgres migrations applied | pass |
| server private key configured | pass |
| HTTPS/trusted tunnel health | pass |
| pinned receipt verification | pass |
| global `lattice authority receipt verify` | pass |
| global `lattice autopilot execute --mode=authority` smoke | pass |

## Risk Register

| Risk | Mitigation |
| --- | --- |
| Runner liveness is mistaken for authority approval. | DONE requires native `gate_decision` receipt. |
| Provider output prose is mistaken for evidence. | Only structured evidence and verified receipts satisfy gates. |
| Legacy receipt shape leaks into native DONE. | Separate verifier paths and negative tests. |
| Authority job executes arbitrary shell. | Structured argv and allowlist policy. |
| Dirty user work is overwritten. | Worktree scope checks and before/after git evidence. |
| Bootstrap token becomes too powerful. | It only authorizes actor key registration. |
| Key discovery is spoofed in production. | HTTPS/tunnel plus key pinning. |
| Non-authority mode contacts the server. | Local/non-authority mode never reads `authority.md` or calls Authority endpoints. |
| Default localhost Authority weakens production. | `http://localhost:6789/` is a local authority development default only; production must be explicit and pinned. |
| Default test key is used for production DONE. | Default test keys and `local-test` profiles are rejected outside deterministic tests/local development. |
| `authority.md` leaks private key material. | The file is internal, gitignored when private material is present, excluded from evidence, and overridden by explicit env/CLI config. |
| Executor loops forever. | Explicit max steps, attempts, wall clock, and no-progress policy. |
| Local autopilot regresses. | Local/shadow regression tests are mandatory in final matrix. |
| Interactive planner modes become untestable chat. | Structured answer/decision/resume commands are mandatory. |
| Autonomous/interview high-risk ambiguity silently hard-blocks. | Bounded 2-3 host decision waves may resolve policy-allowed ambiguity and resume; unresolved decisions stop blocked. |
| Multi-host verification is faked by duplicate sessions. | Independent host rules and verdict endpoints are mandatory. |
| Single-host fallback is mislabeled as full DONE. | Full authority DONE requires multi-host pass; single-host evidence is diagnostic only. |
| Local review is mislabeled as Authority DONE. | Local review sets only `localReviewCertified`; Authority flags remain false. |
| Old verifier verdicts pass after repair. | Repair that changes material state forces fresh anchors, fresh receipts when applicable, and a fresh review wave. |
| Verdict host identity is spoofed in JSON. | Authority derives host identity from authenticated actor/host/session/key binding. |
| Multi-host review becomes an expensive per-step loop. | Review waves run only at final certification or high-risk final gates. |
| Preferred Gemini verifier becomes a hard dependency. | Gemini is a preferred verifier host only when registered and policy requires or prefers it. |
| Agent count is optimized for its own sake. | Concurrency is bounded by milestone wave, non-overlapping write-set, Story readiness, and host independence; 13-15 agents is a temporary burst ceiling, not the default target. |
| Evidence storage grows without bound. | Retention classes and garbage collection rules are required. |
| Provider secrets leak into evidence. | Credential sourcing and redaction policy fail closed. |
| Per-run authority DONE is mislabeled as full DONE. | Final JSON separates `authorityDone` from `fullAuthorityDone` and reports multi-host fields. |
| Planner emits unsupported step types. | Job Planner fixtures prove B1 allowlist compatibility. |
| Evidence idempotency drops records. | Evidence idempotency key includes a per-record sequence or content digest. |
| Source-aligned redevelopment leaks source secrets or proprietary material. | Source is read-only, excluded paths are enforced, secrets are redacted/excluded, and evidence prefers digests/refs. |
| Source-aligned redevelopment launders license obligations. | Required license and attribution notices are preserved or surfaced as blockers. |
| Source-aligned redevelopment overclaims alignment. | DONE requires deterministic module/function alignment maps, rename-map evidence, build/test parity, and explicit gap records. |
| Cross-language redevelopment is marketed as exact semantic identity. | The contract is evidence-backed observable parity plus explicit gaps; Proofbound must not claim perfect equivalence for arbitrary language pairs. |
| A language pair becomes hardcoded special-case behavior. | `sourceLanguage -> targetLanguage` runs through language adapters, neutral manifests, semantic mapping policy, and target-runnable parity oracles. |
| Missing language adapters are hidden behind provider prose. | Missing adapters block or produce scoped gaps; provider output cannot replace deterministic manifest extraction. |
| Source-only tests burn budget in cross-language repair loops. | Untranslatable checks route directly to `gapList[]` or blocked stop reasons instead of repeated repair attempts. |
| Source-aligned redevelopment loops on gaps. | Gap remediation consumes existing repair/no-progress counters plus redevelopment-specific caps and then blocks with `gapList[]`. |

## Completion Definition

This product track is complete only when all of the following are true:

- local autopilot still works without Proofbound Authority;
- local/non-authority mode never connects to Proofbound Authority;
- shadow remains diagnostic/advisory and is not a third user-selected
  unattended development mode;
- authority mode defaults to `http://localhost:6789/` only for local authority
  development and reads explicit env/CLI config or `.lattice/authority.md`;
- default test keys and `authority.md` local-test profiles are rejected for
  deployed production Authority DONE;
- one-sentence, paragraph, and multi-paragraph natural-language requests can be
  transformed into reviewed Proofbound Story drafts;
- `autonomous`, `interview`, and `decision-gated` interaction modes all pass
  their dedicated planner and end-to-end tests;
- `autonomous` and post-confirmation `interview` can use bounded 2-3 host
  decision waves for policy-allowed high-risk ambiguity and continue only when
  resolved;
- omitted interaction mode defaults to `autonomous` and is reported in JSON;
- `interview` and `decision-gated` pause/resume paths are driven by structured
  answer and decision files, not unstructured chat;
- paused planner runs persist state, exit safely, and resume without relying on
  in-memory CLI state;
- `plannerPolicy.allowUnattendedPlanning` gates Story/job creation for
  unattended authority runs;
- anti-over-optimization gate prevents unnecessary scope expansion without
  slowing low-risk autonomous work;
- final multi-host review prompts include `dont optimize for the sake of
  optimization`;
- Story Planner creates or reuses Stories only through Proofbound commands;
- Job Planner creates or reuses Authority jobs with typed `plannedSteps[]`;
- Job Planner also creates local run plans for non-authority unattended
  development when `--mode=local` is selected;
- source-aligned redevelopment workflow is implemented as
  `developmentWorkflow=source_aligned_redevelopment`, not a fourth interaction
  mode;
- source-aligned redevelopment proves authorized source input, read-only source
  handling, source/target language ids, adapter resolution, neutral manifests,
  rename-map evidence, deterministic module/function alignment maps, controlled
  same-language or cross-language semantic mapping, target-runnable build/test
  parity, license notice preservation, secret exclusion, budgeted source
  ingestion, and explicit gap reporting;
- `providerPolicy`, `worktreePolicy`, `retryPolicy`, `stopPolicy`,
  `evidencePolicy`, `receiptPolicy`, `multiHostPolicy`, lease shape, receipt
  freshness, idempotency keys, and `--forceNewRun` behavior are schema-validated
  and tested;
- Job Planner output uses only allowlisted root step types, and planned step
  bindings for provider, validation, repair, and evidence are parsed and tested;
- checklist-to-evidence coverage is complete for every required checklist item;
- authority autopilot can claim an authority job and execute bounded steps;
- provider availability and fallback policy fail closed when required providers
  are unavailable;
- provider execution is captured as structured evidence;
- evidence redaction and retention policy prevents secret leakage while
  preserving verification digests;
- evidence storage lifecycle retains receipt-bound artifacts and permits safe
  garbage collection of expired short-lived logs;
- validation results are uploaded and linked to the job/run;
- local non-authority mode can reach `localReviewCertified=true` only after
  local validation and required independent local verifier verdicts pass;
- local non-authority review never sets `authorityDone`, `fullAuthorityDone`, or
  `multiHostVerified`;
- Proofbound Authority issues a native signed `gate_decision` receipt;
- Proofbound verifies the receipt before authority DONE;
- DONE reconciliation proves local lifecycle, Authority receipt, job completion,
  lease cleanup, and final summary are all aligned;
- review policy supports 2-3 hosts per review wave and preferred 3+ release
  certification, including Gemini as a verifier host when registered and
  available;
- final DONE certification has three bounded host-check waves. Every wave prompt
  includes `don't optimize for the sake of optimization`,
  `don't optimize arbitrarily`, `only fix real correctness issues`, and
  `preserve consistency of logic`; only real correctness blockers can force
  repair. Each wave has at least two
  independent host verdicts over the same final local anchors or the same
  Story/job/evidence/receipt chain;
- verifier verdict records include review wave id, prompt digest, material
  anchors, issued time, and mode-specific receipt or validation anchors;
- any repair that changes material state triggers fresh validation, fresh
  Authority receipt when applicable, and a fresh review wave;
- duplicate same-host or same-session verdicts do not satisfy multi-host final
  verification;
- multi-host verdict submission/listing and disagreement reconciliation are
  implemented and tested;
- single-host fallback can be reported only as diagnostic evidence, not full
  authority DONE;
- final output distinguishes per-run `authorityDone` from multi-host-certified
  `fullAuthorityDone`, distinguishes local review certification, and reports
  `multiHostVerified`, `requiredReviewWaveCount`, `satisfiedReviewWaveCount`,
  and `reviewWaveRefs`;
- request/story/job/evidence/gate operations are idempotent or resume-safe;
- failures stop with a clear blocked summary rather than silent success;
- final output includes an auditable timeline from request intake to final status;
- read-only planner/job status commands expose the current phase, refs, and
  final state without mutating the run;
- global `lattice` passes the full planner/authority/autopilot regression matrix;
- deployed or deployment-grade Proofbound Authority verification passes with a
  pinned server key;
- production Authority verification proves customer API key validation,
  wrong-project rejection, revoked/expired-key rejection, customer-key-gated
  actor enrollment, and dual-credential enforcement for evidence upload, gate
  evaluation, and verifier verdict submission.

Until these criteria pass, the product may claim "Authority control plane
connected" or "local autopilot available," but it must not claim
"natural-language-to-authority-DONE unattended development."
