# B-bfb5 Plan — Reduce Lattice Agent Prompt Token Cost Safely

## Scope Boundaries

This story implements local Lattice CLI token-cost reduction only. It must not change Authority Server receipt semantics, handoff authority boundaries, ownership transfer, merge authority, productionDone, receiptVerified, fullAuthorityDone, review_run_start, review_pass_set, finding_add, init/scope/delivery signatures, or DONE authority claims.

The implementation must keep the fresh-context fence and flow-fact/process-gate semantics that prevent reviewer self-absolution and protect lifecycle evidence. The user-visible result must include measurable before/after prompt-size evidence and an explicit prompt-cache billing caveat.

Tracked prompt surfaces include package prompt templates, `.claude/agents`, and `.Codex/agents` mirrors. Because `.Codex/agents` and Codex adapter assets are tracked, final verification must include Codex adapter verification (`node bin/lattice.js verify_codex` or the canonical equivalent available in this repo) in addition to prompt-size/safety smokes.

## CHK-001 — Validate the token-cost audit document as an executable implementation source

Actions:
- Re-run mechanical checks that support the audit: package/project agent prompt sizes, koala:start snapshot sizes, prompt-registry/global-thin existence, signature domains, story_get/checklist_get duplication.
- Update the audit document only for facts that changed during implementation, especially final measured deltas and caveats.
- Treat char/4 as approximate context-load tokens, not exact billing.

Verification:
- `node packages/main/dist/tasks/prompt-token-cost-smoke.js` must print baseline/final size facts and fail if cited source paths drift.
- The smoke must include the prompt-cache caveat.

## CHK-002 — Replace repeated full agent prompt snapshots with registry-generated load-bearing prompt slices

Actions:
- Use package prompt templates as the managed source; update `.claude/agents` and `.Codex/agents` mirrors consistently.
- Replace repeated full guide snapshots with a compact load-bearing Lattice section that preserves fresh-context, lifecycle flow facts, review-run/finding/pass contract, dispatch evidence discipline, and Authority/handoff non-claim boundaries.
- Prefer a mechanical generation/update helper or registry-backed invariant over manual prose divergence.

Verification:
- Prompt-size smoke must show affected prompt templates no longer contain 50KB+ repeated snapshots.
- Prompt-safety checks must fail if required load-bearing phrases are absent.
- Codex prompt mirrors must be present and verified; prompt changes are incomplete without Codex adapter evidence.

## CHK-003 — Add additive slim read output for high-frequency story inspection commands

Actions:
- Add opt-in `slim` and/or `fields` support for `story_get` and `checklist_get` through handlers and CLI schemas.
- Keep default outputs unchanged for existing callers.
- Slim output should expose compact status/counts and optional fields without repeating full checklist payload unless requested.

Verification:
- Smoke must compare default and slim output shape and size.
- Default compatibility must be explicitly asserted.

## CHK-004 — Add regression checks for prompt-safety and token-reduction invariants

Actions:
- Add a dedicated `prompt-token-cost-smoke` task that verifies before/after size delta, required prompt-safety phrases, default output compatibility, slim output reduction, and non-Authority caveats.
- Run existing prompt registry/managed asset/process-fact relevant smokes as needed.
- Run Codex adapter verification after prompt mirror changes.

Verification:
- Build passes.
- New smoke passes.
- Existing prompt registry smoke remains valid.
- Codex adapter verification passes.
- Validate covers all verificationIntent entries.

## CHK-005 — Run full Lattice review and delivery closure without Authority overclaim

Actions:
- Use normal Lattice lifecycle: DEV implementation, REVIEW lanes, TEST validate, delivery review, summary, DONE gate.
- Record local Non-authority evidence only.
- Delivery review must reject any Authority or handoff semantic overclaim.

Verification:
- concept, quality, test-coverage, docs/channel as required by reviewer_list pass.
- delivery-check records measurement evidence and caveats.
- summary states actual token/context-load delta and limitations.
