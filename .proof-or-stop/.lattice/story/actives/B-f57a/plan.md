# Plan — B-f57a: Automatic cross-host adversarial review (crypto-deferred M1)

## Overview

Turn the manual 2-host quorum into an automatic cross-host adversarial review. Today `quorum_submit`
records a caller-supplied host-B verdict (a human ran Codex by hand in B-ac71); the spawn primitive and
the verdict-capture endpoint exist but share no call edge. This story builds the bridge command
`cross_host_review` that (1) auto-runs Codex as an independent reviewer, (2) captures a structured,
materialHash-bound verdict through the existing capture path, and (3) surfaces where host A (Claude)
and host B (Codex) disagree. Cryptographic signing is explicitly OUT OF SCOPE (deferred as
external-skeptic-only): on a single-machine, same-operator setup, tamper-proofing defends against a
non-existent adversary; the value is the adversarial joint decision, not signatures.

Reuse map (verified against code): `Finding` type (adversarial-review.ts:37), `submitLocalVerdict`
(handlers/verdict.ts:82, binds materialDigest + appends a host_verdict event), materialHash/storyFilesHash
computation (quorum-submit.ts:247-255), command registration (MAIN_TOOLS in cli/command-catalog.ts +
`registerBatch` in registry.ts). Do NOT touch receipt-bundle.ts / authority-signing.ts (crypto) or the
work-signal dispatch verdict field.

## SPIKE result (DONE, 2026-07-03) — mechanism confirmed, corrects the file-drop assumption

Empirically tested Codex CLI 0.141.0 (model gpt-5.5) three ways:
- prompt-as-positional-arg → UNRELIABLE (hangs on "Reading additional input from stdin...").
- workspace-write file-drop → NOT viable (a reviewer must stay read-only; cannot write files).
- **stdin pipe + stdout JSON → WORKS**: `codex exec -s read-only -C <worktree>` with the prompt on
  stdin makes Codex emit the exact verdict JSON as its final message; parsed cleanly.

Therefore the capture mechanism is: pipe the review prompt via STDIN to a read-only `codex exec` (its
OWN bounded spawn, perl FORK+alarm — NOT `runBoundedCodexProvider`, which hides stdout by design),
capture stdout, and parse ONLY the structured JSON verdict block (discard the rest of the transcript so
no raw provider output is promoted to evidence; record a stdoutDigest for provenance). read-only means
Codex cannot modify the code it reviews.

## CHK-001: Auto-run Codex as an independent reviewer and capture a structured materialHash-bound verdict

New module `packages/main/src/core/codex-review-leaf.ts`:
- `buildCodexReviewPrompt(opts)` → a REVIEW-specific prompt (NOT the implementation-flavored
  `dispatchPrompt`) that embeds the target materialHash and instructs Codex to review the change and
  output ONLY a JSON object matching the schema below as its final message.
- `runCodexReviewLeaf(opts, seam)` → pipes the prompt via stdin to a bounded read-only `codex exec -C
  <storyWorktree>`, captures stdout via an injected process seam (for tests), extracts + Zod-validates
  the JSON verdict. Fail-closed: no parseable JSON, schema mismatch, or `materialHash` field != the
  orchestrator-computed digest → synthesized `decision: 'blocked'` with reason
  `codex_review_no_parseable_verdict`. Returns `{ hostBVerdict, stdoutDigest, exitCode }` (never raw stdout).

Verdict schema `lattice.codex_review_verdict.v1`: `{ schemaVersion, decision: 'pass'|'fail'|'blocked',
materialHash, findings: Finding[] (reuse adversarial-review.ts:37 — severity/title/file/line/issue/fix),
summary }`.

Extend `packages/main/src/core/dispatch-policy.ts`: add `allowReviewOnlyRealHostSubprocess?: boolean` to
`DispatchPolicy`; narrow BOTH codex refusal sites (`checkDispatchPolicy` L405-412 and
`checkDispatchPolicyCreate` L256-260) so that when the review-only flag is set, `codex` is permitted
(gemini/antigravity and the general `allowRealHostSubprocess` implementation path stay refused). A NEW
flag, not reuse of `allowRealHostSubprocess`, keeps the implementation refusal fully intact.

Capture: feed the host-B verdict into `submitLocalVerdict(ctx,'local',{storyId, runId, hostId, provider:
'codex', decision, materialDigest, validationDigest, promptDigest, storyFilesHash})` — the existing path,
so the verdict binds to the exact code and appends a `host_verdict` event. `decision` is the REAL Codex
verdict, not a hardcoded 'pass'.

Verification intent: (a) `registry.get('cross_host_review')` is registered; (b) with an injected fake
Codex seam returning stdout carrying a `fail` verdict, a codex-provider verdict is recorded whose
`decision==='fail'` and `materialDigest===currentMaterialHash(root)`; (c) fail-closed: seam returns no
parseable JSON → host-B verdict `decision==='blocked'`, reason mentions `codex_review_no_parseable_verdict`,
and the result exposes a `stdoutDigest` but no raw-stdout field; (d) rebinding guard: seam returns a
verdict whose `materialHash` != computed → `blocked`.

## CHK-002: Combine host-A and host-B verdicts into a joint decision that surfaces disagreements

New module `packages/main/src/core/cross-host-review.ts` (pure, no I/O):
- `diffFindings(hostA: Finding[], hostB: Finding[]) → DisagreementReport` where key =
  `${lower(file)}:${line}:${normalizedTitle}` (title lowercased, whitespace-collapsed). Report:
  `{ schemaVersion:'lattice.cross_host_disagreement.v1', agreed, onlyHostA, onlyHostB, hasDisagreement,
  divergentCount }`.
- `jointDecision(hostAVerdict, hostBVerdict, disagreement) → { hostADecision, hostBDecision,
  jointDecision:'pass'|'blocked', blockedReason?, disagreement }`. Pass iff BOTH hosts pass AND
  `!hasDisagreement`; otherwise blocked (fail-closed). Surfaces WHICH finding one host raised and the
  other missed — the gap the existing `summarizeVerdicts` (verdicts.ts) does not fill (it only counts
  pass/fail hosts, never finding-level divergence).

New handler `packages/main/src/handlers/cross-host-review.ts`: command `cross_host_review`. Flow:
resolve materialDigest/storyFilesHash/headHash like quorum-submit.ts:247-255; load host-A (Claude)
findings from `--hostAFindingsFile` (this M1 consumes Claude's already-authored findings, it does not
spawn a second Claude); run `runCodexReviewLeaf` for host B; capture both verdicts via
`submitLocalVerdict` with distinct derived hostId/session/key (quorum-submit.ts:73-79 pattern); run
`diffFindings` + `jointDecision`; return `CrossHostReviewResult` including the disagreement report.

Register: add a `MAIN_TOOLS` schema entry in `packages/main/src/cli/command-catalog.ts` (near
`quorum_submit`) with Zod args `{ storyId, policy, hostAFindingsFile?, hostA?, hostB?, runId?,
timeoutMinutes?, json?, format? }`; add `registry.registerBatch(createCrossHostReviewHandlers(ctx))` in
`packages/main/src/registry.ts` (near `createQuorumSubmitHandlers`). Both are required (schema + handler).

Reconcile the plan doc: update `docs/requirements/decisions/tier-c-crosshost-quorum-execution-plan.md`
so M1 reflects this crypto-deferred collection+disagreement work and the signed-verdict/pinned-key crypto
is explicitly deferred as an external-skeptic-only future milestone (resolves the INIT product-reviewer's
title/plan-mismatch advisory).

Verification intent: with an injected fake Codex seam returning a `fail` verdict carrying one finding
NOT in host-A's findings → `result.jointDecision.jointDecision==='blocked'`,
`result.disagreement.onlyHostB.length===1`, `result.disagreement.hasDisagreement===true`; and an agreeing
case (same findings, both pass) → `jointDecision==='pass'`, `hasDisagreement===false`.

## Repro-first

RED (un-gameable): a smoke `packages/main/src/tasks/cross-host-review-smoke.ts` whose first assertion is
`assert.ok(registry.get('cross_host_review'))` — FAILS on current main (the orchestration surface does
not exist), passes after implementation. GREEN assertions use an INJECTED FAKE Codex seam (no real CLI
in CI): they drive the disagreement + capture + fail-closed + rebinding paths deterministically. SPIKE:
DONE above (stdin+stdout mechanism confirmed). Run: `node packages/main/dist/tasks/cross-host-review-smoke.js`.

## Out of scope

Cryptographic signing / pinned-key receipts (receipt-bundle.ts, authority-signing.ts untouched — deferred
external-skeptic-only); any Authority-server path (deleted); the work-signal dispatch verdict field; a
second Claude spawn (host A findings are consumed from the caller).

## Risks / open questions

1. Codex invocation MUST use the stdin pipe (prompt-as-arg unreliable in 0.141.0) and read-only; the new
   leaf does its own bounded spawn, never `runBoundedCodexProvider`.
2. materialHash consistency: run Codex against the SAME story worktree so its embedded materialHash
   matches the orchestrator-computed digest (avoids a hash-mismatch class of bugs).
3. Host independence: derive distinct hostId/sessionId/keyId for A and B so verdicts don't collapse in
   `groupByIndependentHost` (verdicts.ts).
4. The dispatch template `['codex','exec','--prompt-file',...]` (lattice-dispatch.ts:487) is stale for
   codex 0.141.0 (no `--prompt-file` flag); the new leaf uses stdin instead — do not route through that
   template.
