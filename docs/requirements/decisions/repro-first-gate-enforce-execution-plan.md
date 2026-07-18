# Repro-First Enforcement PROGRAM (v7 — decomposition after 4 audit rounds)

Status: program-level coordination plan / for audit; no runtime change authorized
Date: 2026-07-18 (v7)
Audit trail: RED×2 → Spike×1 → human×3 → R1(21) → R2(20) → R3(21) → **R4 focused (codex 14: 2 Critical, A/B/C all UNSOUND, REJECT; agy: A/B/C all UNSOUND, REJECT)**.

## Why v7 is a decomposition, not another revision
Four rounds converged the *diagnosis* (unchallenged since R1) but each deepening of the *remedy* exposes another subsystem that must be specified to closeout-trust grade: policy-owned assertion envelopes, supersedes chains with integrity digests, a single transition choke point, quarantine as owner-gated operations. That is a B-9f8a-scale program, not one story. Forcing it into one document is why R2–R4 each returned ~10+ DESIGN findings. Additionally, R4 discovered **four pre-existing repo defects** that block any version of this design and are independently valuable to fix now.

## Workstream 0 — pre-existing defects (immediate, independent stories)
| ID | Defect | Evidence | Why it blocks the program |
|---|---|---|---|
| W0.1 | `dev_finish` writes phase directly, bypassing runStoryTransition/gates entirely (even logs wrong event type) | worktree.ts:1031,1045; registry.ts:182 | any DEV→REVIEW gate is skippable until this door closes |
| W0.2 | validation lock is per-projectRoot — different worktrees/hosts lock independently for the same story | validation-execution-lock.ts:128-133 | serialization assumptions of B-914f reuse AND this program are void cross-host |
| W0.3 | owner lease is not a mutex for same-owner concurrent commands | ownership-gate.ts:282; transition-orchestrator.ts:425→660 non-atomic | bypass consumption / review-round minting can double-fire |
| W0.4 | absolute cwd inside commandSpec digests breaks cross-worktree/host verification | done-required-validation.ts:132,147,155,323 | every receipt-verification design inherits false digest mismatches |
Each is a small, independently testable story; W0.1/W0.2 also harden already-shipped systems (B-10b0/B-914f) regardless of this program.

## Workstream 1 — language-neutral material classification (READY)
= companion doc v4, APPROVE-WITH-CHANGES ×2 hosts in R3, no new findings in R4. Can proceed to story now. Prerequisite for W3.

## Workstream 2 — trusted RED evidence subsystem (needs its own spec story first)
Scope: policy-owned assertion envelope (bounded matchers, minimum specificity, expected exit class, target-exercised proof, GREEN = exit0+!timeout+pattern-absent+target-exists); runner pre/post four-tuple invariance (head/material/index/status) in disposable workspace; supersedes chain with closeout-grade integrity (monotonic seq + prior digest + fork rejection; latest = unique chain head); idempotency key (recordId, materialHash, specDigest, policy/assertion digest, freshness-compatible head); quarantine/recover as owner-gated registered operations creating NEW record IDs linked by recoversRecordId (immutability preserved); retention claims corrected (canonical receipts preserve metadata freshness within a round only — review rounds are per-entry, transition-orchestrator.ts:663). Deliverable: a decision spec authored THROUGH a story (PLAN-reviewed), then implementation stories.

## Workstream 3 — enforcement wiring (after W0.1/W0.3, W1, W2)
Single hash-bound classification snapshot resolved at runStoryTransition entry; ONE pure DEV→REVIEW evaluator consumed by the XState guard, the compatibility path, AND a fail-closed pre-write recheck (machine.ts:909, :837; transition-orchestrator.ts:550); classifier-driven ProofStory triggers (the original core fix); reason-scoped enforce; typed read-error fail-closed; persisted single-use bypass record consumed atomically under the W0.3 transition lock; warn-visibility events from mutating handlers only.

## Sequencing
W0.* (parallel, now) → W1 (now, parallel with W0) → W2 spec story → W2 implementation → W3 → enforce flip. The original goal (four escapees' class becomes impossible) is delivered by W3; every earlier workstream is independently valuable if the program pauses.

## Out-of-scope register (audit-accepted fences)
Closeout receipt cryptographic signing (Tier-C program); reuse-lineage widening to non-material changes (follow-up story); new language parsers.
