# Proof-or-Stop LLM Usage Ledger Execution Plan

> Story: B-1477
> Scope: future execution plan only. This document does not implement source
> code, provider logic, runtime registries, Authority Server behavior, or gate
> behavior.

## Problem Statement

Proof-or-Stop can launch or coordinate work through multiple LLM-capable hosts, but it
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
5. Preserve the existing Proof-or-Stop boundary: local workflow evidence is local
   unless a future receipt-backed Authority path explicitly promotes it.

## Goals

- Add a future JSONL ledger for LLM usage events that can be appended by local
  Proof-or-Stop surfaces and, later, by receipt-backed Authority execution.
- Represent true provider-reported usage, approximate prompt-size estimates, and
  unavailable usage as separate states.
- Support preflight and postflight budget decisions without treating estimates
  as final usage.
- Keep local Non-authority mode usable for ordinary Proof-or-Stop workflow while still
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
- No new authority claim for ordinary Proof-or-Stop CLI, Codex, Claude, Gemini, local
  runners, or host transcripts.
- No replacement for signed `AuthorityReceipt` gate evidence.
- No change to Authority Server receipt contracts in this story.

## Usage Source Semantics

The ledger record must carry a `usage.source` discriminator:

| Source | Meaning | May count as final usage? | May satisfy Authority? |
| --- | --- | --- | --- |
| `provider-reported` | The provider response included usage counters or billing-relevant units returned by the provider adapter. | Yes, for local budget accounting and display. | Only when embedded in a future signed evidence envelope and covered by a verified Authority receipt. |
| `prompt-size-estimate` | Proof-or-Stop estimated prompt size before or around the request, using a local counter, tokenizer, bytes, or characters. | No. It may justify preflight refusal or warnings, but not final usage. | No. |
| `unavailable` | No trusted provider usage and no accepted estimate are available. | No. It records absence explicitly. | No. |

Rules:

- Provider-reported usage wins over estimates for the same completed call.
- Estimates must name the estimator and unit. They must not masquerade as
  provider token counts.
- Unavailable usage must be explicit, not represented as zero.
- A failed request may still write a ledger entry if it consumed budget,
  returned usage, or triggered a budget refusal.
- Ledger readers must never infer that missing counts are zero-cost.

### Estimate accuracy and fallback order

`prompt-size-estimate` records must use the most accurate available estimator,
in a strict, explicitly ordered fallback chain:

1. **Provider `count_tokens` endpoint (preferred).** When the provider exposes a
   token-counting endpoint, the estimate must prefer it. These counts are
   model-version-specific: the same text tokenizes differently across model
   versions, so the count must be requested for the exact target model.
2. **Local tokenizer (fallback).** When the provider endpoint is unavailable,
   fall back to a local tokenizer bound to the same provider/model family.
3. **Bytes/characters heuristic (offline fallback only).** A bytes- or
   character-based heuristic is the lowest-confidence fallback and is used only
   when offline, i.e. when neither the provider endpoint nor a local tokenizer is
   available. It must never be promoted to the preferred estimator.

Every estimate record must:

- record `usage.estimator.confidence` as `high | medium | low`, reflecting which
  method was used (`high` for provider `count_tokens`, `medium` for a local
  tokenizer, `low` for the bytes/chars heuristic);
- bind the estimate to the exact `provider.model` it was computed for, because
  token counts are model-version-specific and an estimate for one model version
  must not be reused for another;
- still record `usage.estimator.name`, `usage.estimator.version`, and
  `usage.estimator.unit` alongside the new `confidence` field.

### Streaming and failure usage capture

Streaming responses report final usage differently from non-streaming responses,
and a naive reader can lose the counts entirely:

- For streaming responses, final usage must be read from the terminal stream
  event (the final `message_delta` / final message that carries the completed
  `usage` object), not assumed from a non-streaming response shape. The usage on
  the terminal event is the authoritative provider-reported count for the call,
  and it still qualifies as `usage.source=provider-reported`.
- A call that errors or times out mid-stream still records the partial output
  usage it actually consumed up to the failure point. An errored call that
  produced tokens still cost budget, so it must not be recorded as zero. If a
  terminal event with partial real counts was received, those partial counts are
  still `provider-reported`, not downgraded to an estimate.
- `usage.source=unavailable` is set only when there is truly no count available —
  no terminal usage event and no partial counts. It must never be used as a
  shortcut, and missing usage must never be defaulted to `0` to pass a budget.

This is consistent with the existing rule that a failed request may still write a
ledger entry when it consumed budget, returned usage, or triggered a refusal.

## Ledger Path and Runtime Artifact Classification

The intended local ledger path is:

```text
.proof-or-stop/usage/llm-usage.jsonl
```

This path is Proof-or-Stop runtime state. A future implementation must register it in
`packages/main/src/core/runtime-artifact-registry.ts` with semantics equivalent
to:

- `id`: `llm-usage-ledger`;
- `matchers`: exact `.proof-or-stop/usage/llm-usage.jsonl` or prefix
  `.proof-or-stop/usage/` if the writer later needs adjacent usage-runtime files;
- `ignorePatterns`: `.proof-or-stop/usage/`;
- `materialHash`: `exclude`;
- `volatile`: `true`;
- `repairableTrackedArtifact`: `true`;
- description: local LLM usage diagnostic ledger for budget accounting and
  operator diagnostics.

The ledger is not process evidence, story evidence, validation evidence, or
gate-consumed proof. It may help operators understand local usage and budget
decisions, but it must not be read as lifecycle evidence under `.proof-or-stop/story/`
or as a replacement for signed Authority receipts. `doctor`, material-hash
calculation, runtime artifact repair, and gitignore management should treat it
the same way they treat other mutable runtime diagnostics under `.proof-or-stop/`.

## Call and Attempt Correlation Semantics

Ledger correlation must be stable before any provider request exists. The
writer must generate call identity locally before preflight estimation, and must
not use `provider.requestIdHash` as the primary key for estimates, blocked
refusals, or summaries.

Required correlation fields:

- `ledgerCallId`: stable id for one logical LLM call requested by Proof-or-Stop. It is
  generated before preflight budget checks and reused by all records for that
  logical call.
- `attemptId`: stable id for one execution attempt within a `ledgerCallId`.
  Retries reuse the same `ledgerCallId` and receive a new `attemptId`.
- `sequence`: positive integer ordered within the same
  `ledgerCallId` + `attemptId`. The preflight estimate is earlier than the
  blocked refusal, provider-reported final record, or unavailable final record
  for the same attempt.
- `supersedesRecordIds`: explicit list of earlier `recordId` values replaced by
  this record for summary accounting. The field is required and may be empty.

Rules:

- A preflight estimate, blocked refusal, postflight provider-reported record,
  and postflight unavailable record for the same attempt must share
  `ledgerCallId` and `attemptId`.
- A blocked refusal must keep the locally generated ids even though no provider
  request was sent and `provider.requestIdHash` is absent.
- A provider-reported final record for an attempt must list the preflight
  estimate record id in `supersedesRecordIds` when both records exist.
- A blocked refusal may list the preflight estimate record id in
  `supersedesRecordIds` when the refusal is the final decision for that
  attempt.
- Ledger summaries must select the latest non-superseded accounting record per
  `ledgerCallId` + `attemptId` for decision counts.
- Final usage totals must count provider-reported usage only once. They must
  exclude superseded prompt-size estimates for the same attempt once
  provider-reported final usage exists.
- Estimates may still appear in a separate diagnostic estimate view, but that
  view must keep `usage.source=prompt-size-estimate` visible and must not merge
  estimates into final provider usage totals.
- `provider.requestIdHash` is optional provider correlation metadata only. It is
  useful after a provider request exists, but it is not stable enough for
  preflight records, blocked records, or cross-source ledger summaries.

## Story and Role Attribution

Attribution fields (`storyId`, `phase`, `role`/`agentType`, and subagent ids)
must be captured at preflight — that is, at call time from the active
lease/session context — not reconstructed after the fact. Post-hoc attribution
drifts when a lease moves on or a session ends between the call and the write, so
the writer snapshots the active context before provider dispatch and binds it to
the `ledgerCallId`.

Attribution rules:

- `storyId` and `phase` are read from the active lease/session context at
  preflight and reused by every record for that `ledgerCallId`.
- Non-story calls (for example a global `validate` run or a background daemon)
  record `storyId=null`. They are NOT dropped: null-story usage is still real
  usage and must appear in summaries under a non-story bucket.
- Subagent and nested calls propagate the parent `storyId` and `phase`, and
  additionally record a subagent/thread identity (`subagentId` / `threadId`) so
  nested usage is traceable back to the parent story while staying
  distinguishable from the parent's own calls.
- Every record carries a `role` / `agentType` field
  (`implementer | reviewer | main | ...`) captured at call time, so summaries can
  break down per-story usage by role.

These fields never gate workflow; they are accounting and diagnostic
attribution only.

## Completeness Guarantee

Accuracy is not only per-record correctness; accuracy is completeness. A
perfectly shaped record is worthless if some provider calls never reach the
ledger at all. A dispatch path that bypasses the writer silently under-counts,
and a silent under-count is indistinguishable from low usage. The plan therefore
treats completeness as a first-class correctness property.

Single writer choke-point:

- All provider dispatch must flow through a single ledger-writing choke-point.
  There is exactly one code path that emits the provider request and the same
  path is responsible for emitting the ledger record(s) for that call. No
  provider call site may dispatch directly without going through this writer.
- This makes completeness true by construction: if a call happened, the
  choke-point saw it, and a record was written (provider-reported, estimate,
  blocked, or unavailable).

Periodic reconciliation:

- A periodic reconciliation check compares the count of provider-dispatch events
  against the count of ledger final records, keyed per
  `ledgerCallId` + `attemptId`. Every dispatched attempt must resolve to exactly
  one final accounting record (provider-reported or unavailable) plus its
  earlier correlated records.
- Any mismatch (a dispatch event with no corresponding ledger final record, or
  the reverse) surfaces a completeness gap for operator attention. The
  reconciliation surfaces gaps; it does not silently reconcile them away.
- Reconciliation cannot run on `provider.requestIdHash` alone because blocked and
  preflight records have no provider request; it uses the locally generated
  `ledgerCallId` + `attemptId` correlation key.

## JSONL Ledger Record Shape

The local ledger is append-only JSONL. One line represents one budget-relevant
LLM call attempt or refusal.

The `usage` object records token counts using the full cache-aware token model.
Provider-reported usage carries four first-class token fields:

- `inputTokens`: the uncached remainder of the input only. This is NOT the total
  input. When prompt caching is active, the cached portion of the input is
  reported separately in `cacheReadInputTokens` (and, on the first write, in
  `cacheCreationInputTokens`); `inputTokens` is only the part of the input that
  was neither served from cache nor written to cache.
- `outputTokens`: tokens generated by the model in the response.
- `cacheCreationInputTokens`: input tokens written to the prompt cache on this
  call (cache writes cost more than base input).
- `cacheReadInputTokens`: input tokens served from the prompt cache on this call
  (cache reads cost a small fraction of base input).

This four-field shape matches prior art already in production: Managed Agents
(CMA) record exactly these four fields in
`span.model_request_end.model_usage`, so the ledger reuses the same shape rather
than inventing a new one. The real processed volume of a call is therefore
`inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens`,
not `inputTokens + outputTokens` alone.

Each record also carries a normalized canonical view and a raw provider digest
(see Multi-Provider Normalization below) so cross-source summaries stay
comparable without discarding provider fidelity.

```json
{
  "schemaVersion": 1,
  "recordId": "llmuse_01H...",
  "ledgerCallId": "llmcall_01H...",
  "attemptId": "llmatt_01H...",
  "sequence": 2,
  "supersedesRecordIds": ["llmuse_01H..."],
  "recordedAt": "2026-06-15T00:00:00.000Z",
  "projectRootHash": "sha256:...",
  "storyId": "B-1477",
  "phase": "DEV",
  "agentType": "implementer",
  "subagentId": null,
  "threadId": null,
  "command": "dispatch_auto",
  "host": {
    "kind": "codex",
    "sessionIdHash": "sha256:...",
    "runnerIdHash": "sha256:..."
  },
  "provider": {
    "name": "anthropic",
    "model": "claude-opus-4-8",
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
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 0,
    "canonical": {
      "input": 1200,
      "output": 340,
      "cacheCreation": 0,
      "cacheRead": 0
    },
    "raw": {
      "providerUnits": "anthropic-usage-v1",
      "payloadDigest": "sha256:..."
    },
    "billableUnits": [
      {
        "kind": "tokens",
        "name": "input",
        "quantity": 1200
      },
      {
        "kind": "tokens",
        "name": "output",
        "quantity": 340
      },
      {
        "kind": "tokens",
        "name": "cache_creation",
        "quantity": 0
      },
      {
        "kind": "tokens",
        "name": "cache_read",
        "quantity": 0
      }
    ],
    "estimator": null,
    "unavailableReason": null,
    "pricingRef": "price-table@2026-06-15"
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

- `recordId`, `ledgerCallId`, `attemptId`, `sequence`,
  `supersedesRecordIds`, `recordedAt`, `schemaVersion`, `decision.kind`, and
  `usage.source` are required.
- `ledgerCallId` and `attemptId` must be generated by Proof-or-Stop before provider
  dispatch. They must not be derived from `provider.requestIdHash`.
- `agentType` is required and is captured at preflight. `storyId` and `phase` are
  captured at preflight from the active lease/session context; `storyId` may be
  `null` for non-story calls but the field must be present (never omitted to hide
  non-story usage). Subagent/nested records additionally set `subagentId` /
  `threadId` and inherit the parent `storyId`.
- `sequence` must be monotonic for records with the same `ledgerCallId` and
  `attemptId`.
- `supersedesRecordIds` must be present on every record. Use an empty array when
  no earlier record is superseded.
- `usage.source=provider-reported` requires at least one provider-returned
  usage unit or an explicit provider usage payload digest. Raw provider payloads
  are not stored.
- For `usage.source=provider-reported`, all four token fields
  (`inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
  `cacheReadInputTokens`) must be present on every provider-reported record. A
  value of `0` is only allowed when the provider genuinely reports `0` for that
  field; it must never be inferred or used to paper over a field the provider did
  not return.
- Per-dimension absence rule (authoritative): `usage.source` is a record-level
  discriminator describing the source of the PRIMARY input/output counts. A
  provider that returns input/output counts is `provider-reported` for the whole
  record, even when it does not report cache dimensions. Do NOT overload
  `usage.source` to express per-dimension absence (there is no
  "`usage.source=unavailable` for the cache dimension"). Instead, when a provider
  does not report a cache dimension, set the canonical
  `cacheCreationInputTokens` / `cacheReadInputTokens` (and the matching
  `usage.canonical.cacheCreation` / `usage.canonical.cacheRead`) to `null` (JSON
  `null`), never `0` and never omitted. `null` means "unavailable for this
  dimension" and is explicitly distinct from a provider-reported `0`. This
  preserves the "never treat missing as zero" principle at the field level
  (`null`, not `0`).
- `inputTokens` is the uncached remainder, not the total input; cached input is
  accounted for separately in `cacheReadInputTokens` and
  `cacheCreationInputTokens`.
- A `totalTokens` field must NOT be stored on the record. Totals are derived in
  the summary layer (see "Derived Totals" below).
- `usage.source=prompt-size-estimate` requires `usage.estimator.name`,
  `usage.estimator.version`, `usage.estimator.unit`, `usage.estimator.confidence`,
  the bound `provider.model`, and estimated quantity.
- `usage.source=unavailable` requires `usage.unavailableReason`.
- Every provider-reported record must carry both the raw provider digest
  (`usage.raw`) and the normalized `usage.canonical`
  `{input, output, cacheCreation, cacheRead}` view.
- Records may carry `usage.pricingRef` / `pricingVersion` referencing a versioned
  price-table snapshot, but must never store an absolute dollar amount or
  hardcoded per-token price (see Cost Derivability).
- `decision.kind=blocked` records fail-closed budget behavior and must not send
  a provider request after the block decision.
- Hashes are for correlation and tamper evidence; they do not make a local
  record authoritative.

## Derived Totals

Totals are not stored on the append-only record. A stored total drifts the moment
the cache-token fields exist (a writer that only summed `inputTokens +
outputTokens` would silently undercount cache traffic), so totals are computed in
the ledger summary layer from the first-class token fields instead.

The summary layer derives total processed volume using the identity:

```text
total_processed = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
```

Rules:

- No record may store `totalTokens` (or any equivalent pre-summed field). Totals
  are summary-derived only.
- The summary layer applies the identity above per accounting record, then
  aggregates across the latest non-superseded records per
  `ledgerCallId` + `attemptId`.
- Because the total is derived, it always reflects the current set of token
  fields and cannot fall out of sync with the cache-token accounting.

## Multi-Provider Normalization

Providers report usage with different field names and unit semantics. Two goals
are in tension: preserving provider-specific fidelity (so nothing is lost or
misinterpreted) and producing cross-source summaries (so usage across providers
can be compared). The plan resolves the tension by requiring BOTH views on every
provider-reported record, not one or the other:

- `usage.raw`: the raw provider units and a provider usage `payloadDigest`,
  preserving provider-specific meaning. The raw view is never discarded in favor
  of the canonical view; canonical is additive, not a replacement.
- `usage.canonical`: a normalized canonical view with exactly four fields
  `{input, output, cacheCreation, cacheRead}`, matching the four-field token
  model. Cross-source summaries read the canonical view so providers are
  comparable.

Mapping rules (provider cache/cached-token fields to canonical cache fields):

- Each provider adapter must declare an explicit mapping from its reported usage
  fields to the canonical `{input, output, cacheCreation, cacheRead}` fields. The
  mapping must be explicit and reviewable, never implicit.
- Anthropic-shaped providers map `input_tokens -> input`,
  `output_tokens -> output`, `cache_creation_input_tokens -> cacheCreation`, and
  `cache_read_input_tokens -> cacheRead`.
- Providers that report only a single "cached tokens" figure (cache reads, with
  no separate write count) map that figure to `cacheRead` and set
  `cacheCreation` according to what the provider actually reports; a value the
  provider does not report must not be inferred (see the provider-reported
  constraint on never inferring `0`).
- Providers that do not expose cache tokens at all set the canonical
  `cacheCreation` and `cacheRead` to `null` (and likewise the record's
  `cacheCreationInputTokens` / `cacheReadInputTokens`) rather than a silent `0`,
  while still mapping `input` and `output`. The record stays
  `usage.source=provider-reported` because input/output are provider-reported;
  per-dimension absence is expressed by setting those cache fields to `null`, not
  by `usage.source` (see the per-dimension absence rule under "Required record
  constraints"). For example, an OpenAI-style provider that reports only
  input/output emits `cacheCreationInputTokens: null` and
  `cacheReadInputTokens: null` (canonical `cacheCreation: null`,
  `cacheRead: null`).
- `canonical.input` follows the same uncached-remainder semantics as
  `inputTokens`: it is the uncached input only, not the gross input.

## Cost Derivability

Per-token prices change over time, and cache reads/writes are priced differently
from base input (cache reads cost roughly a small fraction of base input; cache
writes cost more than base input, with different multipliers for different cache
TTLs). A dollar amount baked into an append-only record therefore goes stale and
becomes wrong the next time pricing changes, and an append-only record cannot be
corrected. Cost is consequently never stored as an absolute amount on the record.

Rules:

- Cost is derived only in a dedicated layer that pins `provider.model` plus a
  date to a versioned price table (per-model $/MTok plus cache-read and
  cache-write multipliers). The four-field/canonical token counts feed that
  derivation.
- The record carries a `pricingRef` / `pricingVersion` reference (a pointer to
  the versioned price-table snapshot in effect at `recordedAt`), not absolute
  prices. The price-table snapshot mechanism is what maps a `pricingRef` to the
  concrete per-model rates and cache multipliers.
- No absolute dollar amount or hardcoded per-token price may be baked into the
  append-only record beyond the `pricingRef` reference. The append-only record
  stays a token-and-reference record; money is computed downstream.

## Local Non-authority Boundary

The local ledger belongs to ordinary Proof-or-Stop workflow. It is a diagnostic and
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
- Proof-or-Stop CLI may project that receipt into local status only after receipt
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
   - write to `.proof-or-stop/usage/llm-usage.jsonl`;
   - add the runtime artifact registry entry and gitignore behavior for that
     path;
   - add a single append-only writer choke-point that all provider dispatch flows
     through (no second writer path; see Completeness Guarantee);
   - generate `ledgerCallId`, `attemptId`, `sequence`, and
     `supersedesRecordIds` before provider dispatch;
   - reject raw prompt and transcript fields at runtime;
   - include hash chaining for local tamper detection.
2. Provider adapter extraction:
   - map each provider's reported usage into the shared `provider-reported`
     shape;
   - preserve provider-specific units in the raw view without normalizing away
     meaning, AND emit the normalized canonical
     `{input, output, cacheCreation, cacheRead}` view (see Multi-Provider
     Normalization);
   - declare each provider's explicit cache/cached-token mapping into the
     canonical cache fields;
   - attach final provider records to the locally generated call and attempt
     ids;
   - record `unavailable` when provider usage is absent.
3. Estimate path:
   - add preflight prompt-size estimate records for budget checks;
   - prefer the provider `count_tokens` endpoint, fall back to a local tokenizer,
     then to a bytes/chars heuristic only when offline (see Estimate accuracy
     and fallback order);
   - label estimator name, version, unit, and confidence (`high | medium | low`),
     and bind the estimate to the exact `provider.model`;
   - keep estimate records separate from final provider-reported records;
   - mark estimate records superseded when a provider-reported final record or
     blocked refusal replaces them for summary accounting.
4. Budget policy:
   - define local, shadow, and Authority-required budget modes;
   - make over-budget preflight decisions fail closed before provider calls;
   - make postflight provider-reported overages visible and auditable.
5. Status and diagnostics:
   - read ledger summaries without changing gates;
   - derive totals via the summary identity rather than reading a stored total;
   - derive cost only in a layer that pins model+date to a versioned price table
     via `pricingRef`, never from a per-record dollar amount (see Cost
     Derivability);
   - surface unknown or unavailable usage as unknown, not zero;
   - exclude superseded estimates from final usage totals;
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

- runtime artifact policy classifies `.proof-or-stop/usage/llm-usage.jsonl` as
  gitignored, `materialHash=exclude`, `volatile=true`, and
  `repairableTrackedArtifact=true`;
- preflight estimate, blocked refusal, and postflight final records share stable
  locally generated `ledgerCallId` and `attemptId`;
- provider-reported usage writes `usage.source=provider-reported` and keeps
  provider counts distinct from estimates;
- provider-reported usage records all four token fields (`inputTokens`,
  `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`) with
  `inputTokens` as the uncached remainder, and never infers a missing field as
  `0`;
- no record stores `totalTokens`; the summary layer derives totals via the
  identity `inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens`;
- every provider-reported record carries both the raw provider digest
  (`usage.raw`) and the normalized canonical
  `{input, output, cacheCreation, cacheRead}` view, and each provider's cache
  mapping is exercised;
- provider-reported final usage supersedes same-attempt estimates, and summary
  totals do not double count the estimate;
- blocked refusals remain correlated without `provider.requestIdHash`;
- prompt estimate prefers the provider `count_tokens` endpoint, records
  `usage.estimator.confidence` (high|medium|low), and binds to the exact
  `provider.model`; the bytes/chars heuristic only appears as the lowest-confidence
  offline fallback;
- prompt estimate writes `usage.source=prompt-size-estimate` and cannot satisfy
  final usage assertions;
- attribution is captured at call time: non-story calls record `storyId=null`
  and are still summarized (not dropped), subagent/nested calls propagate the
  parent `storyId` with a `subagentId`/`threadId`, and each record carries
  `agentType`/`role`;
- a single ledger-writing choke-point handles all provider dispatch, and a
  reconciliation check (provider-dispatch events vs ledger final records per
  `ledgerCallId` + `attemptId`) surfaces completeness gaps from a bypassed
  writer;
- streaming responses read final usage from the terminal stream event
  (`message_delta`/final message), and a mid-stream error/timeout still records
  the partial output usage consumed as `provider-reported`;
- cost is derived only via a `pricingRef`/`pricingVersion` snapshot pinning
  model+date to a versioned price table, and no absolute dollar amount is stored
  on the record;
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
   - freeze the JSONL discriminator semantics and the four-field cache-token
     model (`inputTokens`, `outputTokens`, `cacheCreationInputTokens`,
     `cacheReadInputTokens`) with derived totals and no stored `totalTokens`;
   - freeze the canonical normalization shape and `pricingRef` reference rule;
   - identify every current LLM call surface and route them through the single
     ledger-writing choke-point.
2. Local writer behind opt-in flag:
   - append local records in dry-run or shadow mode through the single
     choke-point;
   - capture call-time attribution (`storyId`/`phase`, null-story, subagent ids,
     `agentType`);
   - run privacy and raw-content rejection tests;
   - run the dispatch-vs-record reconciliation check;
   - keep summaries informational and derive totals/cost rather than storing
     them.
3. Local budget enforcement:
   - enable fail-closed preflight behavior for explicit hard budgets;
   - keep provider-reported postflight usage visible;
   - preserve local workflow when no budget is configured.
4. Provider coverage:
   - add provider-reported mappings one provider at a time, emitting both the raw
     provider digest and the canonical view with explicit cache-field mapping;
   - capture cache tokens (`cacheCreationInputTokens`, `cacheReadInputTokens`)
     and streaming/terminal-event usage per provider;
   - record `usage.source=unavailable` explicitly for unsupported providers;
   - for a provider-reported record where the provider does not report a cache
     dimension, set that canonical cache field to `null` (never a silent `0`),
     keeping the record `provider-reported` (see the per-dimension absence rule
     under "Required record constraints");
   - prefer the provider `count_tokens` endpoint for estimates where available;
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
- The ledger path is `.proof-or-stop/usage/llm-usage.jsonl` and is specified as a
  runtime diagnostic artifact excluded from material hash, ignored by git, and
  repairable by runtime artifact tooling.
- JSONL records include stable call and attempt ids, sequence,
  `supersedesRecordIds`, budget decision, usage source, privacy flags, local
  Authority boundary fields, and integrity hashes.
- Provider-reported usage records the four-field cache-token model
  (`inputTokens` uncached remainder, `outputTokens`, `cacheCreationInputTokens`,
  `cacheReadInputTokens`); no `totalTokens` is stored, and totals are derived in
  the summary layer.
- Estimates prefer the provider `count_tokens` endpoint, record an estimator
  confidence (high|medium|low), and are bound to the exact `provider.model`.
- Attribution is captured at call time: non-story calls record `storyId=null`
  without being dropped, subagent/nested calls propagate the parent story with a
  subagent/thread id, and a `role`/`agentType` field supports per-role breakdowns.
- Completeness is guaranteed by a single ledger-writing choke-point plus a
  reconciliation check (dispatch events vs ledger final records per
  `ledgerCallId` + `attemptId`) that surfaces gaps.
- Streaming usage is read from the terminal stream event, and mid-stream
  errors/timeouts still record the partial output usage consumed.
- Each provider-reported record carries both the raw provider digest and the
  normalized canonical `{input, output, cacheCreation, cacheRead}` view with
  explicit per-provider cache mapping rules.
- Cost is derived only via a versioned `pricingRef`/`pricingVersion` snapshot; no
  absolute price is baked into the append-only record.
- Summaries do not double count preflight estimates after provider-reported
  final usage exists for the same attempt.
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
