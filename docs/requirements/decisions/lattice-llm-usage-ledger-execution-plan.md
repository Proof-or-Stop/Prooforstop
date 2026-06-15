# Lattice LLM Usage Ledger Execution Plan

> Story: B-1477
> Scope: future execution plan only. This document does not implement source
> code, provider logic, runtime registries, Authority Server behavior, or gate
> behavior.

## Problem Statement

Lattice can launch or coordinate work through multiple LLM-capable hosts, but it
does not yet have one consistent place to record what each model call consumed,
what budget decision was made before the call, and whether final usage came from
the provider, from a local prompt-size estimate, or from no reliable source at
all.

Without a usage ledger, future budget decisions risk mixing three different
facts:

- true provider-reported usage returned by the model provider;
- approximate prompt-size estimates made before or around a request;
- unavailable usage when neither the provider nor a trusted adapter reports
  counts.

The ledger must keep these categories mechanically distinct. A local estimate is
useful for preflight safety, but it is not billing truth, receipt truth, or
Authority evidence.

## Principles

1. Do not optimize for optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Follow consistency of logic across providers, hosts, and Authority modes.
5. Preserve the existing Lattice boundary: local workflow evidence is local
   unless a future receipt-backed Authority path explicitly promotes it.

## Goals

- Add a future JSONL ledger for LLM usage events that can be appended by local
  Lattice surfaces and, later, by receipt-backed Authority execution.
- Represent true provider-reported usage, approximate prompt-size estimates, and
  unavailable usage as separate states.
- Support preflight and postflight budget decisions without treating estimates
  as final usage.
- Keep local Non-authority mode usable for ordinary Lattice workflow while still
  recording budget refusals and available usage facts.
- Define the Authority Server receipt-backed path for future production
  accounting without overclaiming local authority.
- Prevent raw prompt, raw transcript, provider secret, customer API key, actor
  key, and authorization header material from entering ledger records.

## Non-Goals

- No source code change in this story.
- No provider adapter rewrite.
- No pricing optimizer, model router, or arbitrary cost-saving feature.
- No token-perfect estimator. Estimates are bounded diagnostics and preflight
  guards only.
- No new authority claim for ordinary Lattice CLI, Codex, Claude, Gemini, local
  runners, or host transcripts.
- No replacement for signed `AuthorityReceipt` gate evidence.
- No change to Authority Server receipt contracts in this story.

## Usage Source Semantics

The ledger record must carry a `usage.source` discriminator:

| Source | Meaning | May count as final usage? | May satisfy Authority? |
| --- | --- | --- | --- |
| `provider-reported` | The provider response included usage counters or billing-relevant units returned by the provider adapter. | Yes, for local budget accounting and display. | Only when embedded in a future signed evidence envelope and covered by a verified Authority receipt. |
| `prompt-size-estimate` | Lattice estimated prompt size before or around the request, using a local counter, tokenizer, bytes, or characters. | No. It may justify preflight refusal or warnings, but not final usage. | No. |
| `unavailable` | No trusted provider usage and no accepted estimate are available. | No. It records absence explicitly. | No. |

Rules:

- Provider-reported usage wins over estimates for the same completed call.
- Estimates must name the estimator and unit. They must not masquerade as
  provider token counts.
- Unavailable usage must be explicit, not represented as zero.
- A failed request may still write a ledger entry if it consumed budget,
  returned usage, or triggered a budget refusal.
- Ledger readers must never infer that missing counts are zero-cost.

## JSONL Ledger Record Shape

The local ledger is append-only JSONL. One line represents one budget-relevant
LLM call attempt or refusal.

```json
{
  "schemaVersion": 1,
  "recordId": "llmuse_01H...",
  "recordedAt": "2026-06-15T00:00:00.000Z",
  "projectRootHash": "sha256:...",
  "storyId": "B-1477",
  "phase": "DEV",
  "command": "dispatch_auto",
  "host": {
    "kind": "codex",
    "sessionIdHash": "sha256:...",
    "runnerIdHash": "sha256:..."
  },
  "provider": {
    "name": "openai",
    "model": "gpt-5",
    "requestIdHash": "sha256:..."
  },
  "decision": {
    "kind": "allowed",
    "budgetPolicyId": "local-default",
    "budgetScope": "story",
    "reasonCode": "within_budget"
  },
  "usage": {
    "source": "provider-reported",
    "inputTokens": 1200,
    "outputTokens": 340,
    "totalTokens": 1540,
    "billableUnits": [
      {
        "kind": "tokens",
        "name": "input",
        "quantity": 1200
      }
    ],
    "estimator": null,
    "unavailableReason": null
  },
  "privacy": {
    "promptStored": false,
    "transcriptStored": false,
    "redactionProfile": "no-raw-content-v1"
  },
  "authority": {
    "mode": "local",
    "receiptId": null,
    "receiptVerified": false,
    "receiptSubjectKind": null,
    "receiptSubjectId": null
  },
  "integrity": {
    "previousRecordHash": "sha256:...",
    "recordHash": "sha256:..."
  }
}
```

Required record constraints:

- `recordId`, `recordedAt`, `schemaVersion`, `decision.kind`, and
  `usage.source` are required.
- `usage.source=provider-reported` requires at least one provider-returned
  usage unit or an explicit provider usage payload digest. Raw provider payloads
  are not stored.
- `usage.source=prompt-size-estimate` requires `usage.estimator.name`,
  `usage.estimator.version`, `usage.estimator.unit`, and estimated quantity.
- `usage.source=unavailable` requires `usage.unavailableReason`.
- `decision.kind=blocked` records fail-closed budget behavior and must not send
  a provider request after the block decision.
- Hashes are for correlation and tamper evidence; they do not make a local
  record authoritative.

## Local Non-authority Boundary

The local ledger belongs to ordinary Lattice workflow. It is a diagnostic and
budget-accounting artifact, not Authority evidence.

Local Non-authority rules:

- Local ledger records must keep `authority.mode=local` or `shadow` unless a
  future explicit receipt-backed path writes a verified receipt reference.
- Local records must keep `authority.receiptVerified=false`.
- Local records must not set `productionDone`, `authorityChanged`, or any
  equivalent Authority-completion flag.
- Local prompt-size estimates must never become `receipt-backed-l2-plus`.
- Host transcripts, local JSONL lines, dispatch receipts, and transport
  `accepted=true` responses must not be treated as signed Authority receipts.
- Missing Authority configuration must not block ordinary local workflow unless
  a command is explicitly running in an Authority-required budget mode.

## Authority Server Receipt-Backed Path

The future Authority Server path is separate from the local ledger path.

Receipt-backed requirements:

- The execution plane submits a privacy-preserving usage evidence envelope to
  the Authority Server.
- The Authority Server validates provider-reported usage, budget policy,
  project/story/run binding, actor identity, and evidence adequacy.
- The Authority Server signs an `AuthorityReceipt` or receipt proof that binds
  the ledger-relevant usage decision to the subject, digest, server key, and
  policy version.
- Lattice CLI may project that receipt into local status only after receipt
  signature verification and subject binding pass.
- A local ledger line may include `authority.receiptId` only as a reference to a
  verified server receipt. The local line itself is not the receipt.

Negative controls:

- Transport acceptance without a signed receipt is not Authority usage proof.
- A provider response with real token counts is not Authority proof by itself.
- A local estimate is not Authority proof.
- A local JSONL hash chain is not Authority proof.
- A copied receipt id without signature verification and subject binding is not
  Authority proof.

## Implementation Touchpoints

Future implementation should be split into narrow slices:

1. Ledger schema and writer:
   - define the JSONL schema and validators;
   - add append-only writer APIs;
   - reject raw prompt and transcript fields at runtime;
   - include hash chaining for local tamper detection.
2. Provider adapter extraction:
   - map each provider's reported usage into the shared `provider-reported`
     shape;
   - preserve provider-specific units without normalizing away meaning;
   - record `unavailable` when provider usage is absent.
3. Estimate path:
   - add preflight prompt-size estimate records for budget checks;
   - label estimator name, version, unit, and confidence;
   - keep estimate records separate from final provider-reported records.
4. Budget policy:
   - define local, shadow, and Authority-required budget modes;
   - make over-budget preflight decisions fail closed before provider calls;
   - make postflight provider-reported overages visible and auditable.
5. Status and diagnostics:
   - read ledger summaries without changing gates;
   - surface unknown or unavailable usage as unknown, not zero;
   - avoid model-routing or optimization advice in the first slice.
6. Authority integration:
   - define the evidence envelope fields needed by Authority Server;
   - verify receipt signatures and subject binding before setting receipt refs;
   - keep receipt-backed code paths isolated from local ledger append paths.

## Fail-Closed Budget Behavior

Budget behavior must be conservative:

- If a preflight estimate exceeds a hard budget, block the request and write a
  `decision.kind=blocked` ledger entry.
- If budget state cannot be read in an Authority-required mode, block the
  request.
- If provider-reported usage is required by policy but unavailable after a call,
  mark the result as policy failure and require explicit remediation.
- If local mode has no budget policy configured, do not invent a budget; record
  `decision.kind=allowed` with `budgetPolicyId=null` when a call is made.
- If an estimate is stale relative to prompt construction, rerun the estimate or
  block in strict modes.
- Never treat unavailable usage as zero to pass a budget.

Authority-required budget mode must fail closed when the required receipt-backed
evidence is absent, stale, unverifiable, or bound to a different subject.
Ordinary local mode should remain usable and should report warnings rather than
global blockers.

## Privacy Constraints

The ledger must not store raw prompt, raw completion, raw transcript, raw tool
arguments, provider secrets, customer API keys, actor keys, authorization
headers, or unredacted environment variables.

Allowed privacy-preserving fields:

- hashes of request ids, session ids, runner ids, and project roots;
- model and provider names;
- usage counts and provider-returned billing units;
- budget policy ids and reason codes;
- redaction profile id;
- receipt ids and verified subject refs when a future receipt-backed path exists.

If debugging needs content correlation, store a separate redacted evidence
artifact with an explicit retention policy. Do not backdoor raw prompt or raw
transcript content into the usage ledger.

## Validation / Smoke Plan

Targeted future tests:

- provider-reported usage writes `usage.source=provider-reported` and keeps
  provider counts distinct from estimates;
- prompt estimate writes `usage.source=prompt-size-estimate` and cannot satisfy
  final usage assertions;
- absent provider usage writes `usage.source=unavailable` with a reason;
- preflight hard-budget excess writes `decision.kind=blocked` and does not call
  the provider;
- unavailable budget state in Authority-required mode blocks the request;
- local mode without Authority config still records local usage and does not
  claim receipt verification;
- raw prompt and raw transcript field injection is rejected;
- authorization header, provider key, customer API key, and actor key values are
  redacted from records and logs;
- receipt-backed path accepts only a verified Authority receipt with matching
  subject binding;
- transport `accepted=true`, local JSONL records, host transcripts, and provider
  usage alone do not set receipt-backed status;
- ledger summary treats unavailable usage as unknown, not zero;
- hash-chain verification detects local tampering without claiming Authority.

Smoke commands should be named narrowly, for example:

```bash
npm --prefix packages/main run test:llm-usage-ledger-schema
npm --prefix packages/main run test:llm-usage-ledger-budget
npm --prefix packages/main run test:llm-usage-ledger-privacy
npm --prefix packages/main run test:llm-usage-ledger-authority-boundary
```

## Rollout Phases

1. Documentation and schema freeze:
   - approve this execution plan;
   - freeze the JSONL discriminator semantics;
   - identify every current LLM call surface.
2. Local writer behind opt-in flag:
   - append local records in dry-run or shadow mode;
   - run privacy and raw-content rejection tests;
   - keep summaries informational.
3. Local budget enforcement:
   - enable fail-closed preflight behavior for explicit hard budgets;
   - keep provider-reported postflight usage visible;
   - preserve local workflow when no budget is configured.
4. Provider coverage:
   - add provider-reported mappings one provider at a time;
   - record unavailable usage explicitly for unsupported providers;
   - avoid arbitrary estimator tuning unless it fixes a real correctness issue.
5. Authority receipt-backed path:
   - submit privacy-preserving usage evidence envelopes;
   - verify signed receipts and subject binding;
   - expose receipt refs without promoting local records into authority.
6. Default-on local ledger:
   - enable append-only local usage records by default after privacy, budget, and
     boundary smoke tests are stable.

## Acceptance Criteria

- The ledger design distinguishes `provider-reported`, `prompt-size-estimate`,
  and `unavailable` usage in schema and behavior.
- JSONL records include budget decision, usage source, privacy flags, local
  Authority boundary fields, and integrity hashes.
- Local Non-authority mode remains diagnostic and does not claim receipt
  verification or production authority.
- The Authority Server path requires signed receipt verification and subject
  binding before any receipt-backed status is displayed.
- Hard budget modes fail closed when usage or policy facts are missing, stale, or
  over budget.
- No raw prompt, raw transcript, secret, customer API key, actor key, or
  authorization header can be written to the ledger.
- Validation includes provider usage, estimate, unavailable, budget block,
  privacy rejection, and Authority overclaim negative controls.
- Rollout proceeds in narrow phases and fixes only correctness issues needed for
  consistent ledger semantics.
