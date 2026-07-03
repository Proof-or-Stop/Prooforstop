# B-f57a — Real-machine acceptance transcript & diff (TEST)

Story: Tier-C M1 (crypto-deferred) — `cross_host_review` auto cross-host review collection +
finding-level disagreement surfacing.
Rhythm: PLAN outcome = **expected** → run on real machine → **actual** → **diff**.

Scope note: M1 delivers the CAPABILITY (the command + leaf + disagreement diff), verified
deterministically via an injected fake-Codex seam. A single LIVE end-to-end 2-host run against the
real Codex CLI is the separate **M3 (proof-of-mechanism)** milestone — deliberately NOT in M1's scope.

## Expected (PLAN)
1. `cross_host_review` is a registered command.
2. It auto-runs a read-only Codex reviewer, captures a STRUCTURED verdict bound to the exact
   materialHash via the existing `submitLocalVerdict` path, and FAILS CLOSED on unparseable /
   schema-invalid / materialHash-mismatched / non-zero-exit output (never surfacing raw stdout).
3. It combines host-A (Claude) + host-B (Codex) verdicts into a joint decision that surfaces
   finding-level disagreements (findings raised by exactly one host); pass iff both pass AND no
   disagreement.
4. The review-only codex subprocess is gated by a sanctioned dispatch policy (fail-closed if
   missing/unauthorized), cannot reach the implementation dispatch path, and receives a
   credential-redacted env + a policy timeout ceiling.

## Run + actual
- `node packages/main/dist/tasks/cross-host-review-smoke.js` → **21/21 checks pass**:
  - CHK-001 (12): registration; fail-verdict capture + materialDigest binding; fail-closed on
    garbage / missing-field / material-mismatch / non-zero-exit; no-raw-stdout; malicious-text
    injection ignored; dispatch-policy refuses non-review codex + gemini/antigravity; both-flags
    mutual-exclusion refused; missing/unauthorized policy fail-closed; env-denylist+secret-strip+
    timeout-ceiling threaded to the spawn.
  - CHK-002 (9): disagreement (host-B-only), agreeing pass, symmetric host-A-only, one-pass-one-fail,
    title-case normalization, both-fail-same-findings, blocked-propagation, divergent-materialHash
    blocked, duplicate-finding dedup.
- `lattice validate` → **allPass: true** (32 configured commands incl. the full smoke suite; build tsc clean).
- `intent_coverage_check` → 21/21 intents covered, 0 gaps, evidence fresh (non-stale, bound to current materialHash).

## Diff
No diff — expected == actual. Every PLAN-promised behavior is exercised by a labelled, non-hollow
check (confirmed by the test-coverage lane RP-005). All nine REVIEW findings (F-001…F-009 across two
rounds) were fixed and re-reviewed clean in Round 3 (concept RP-003, quality PASS, test-coverage RP-005).

## Verdict
Accepted. The cross-host review capability is delivered and deterministically verified; the
independence claim stays honestly bounded (cross-vendor, same-operator; no crypto — deferred to
M-crypto). A live real-Codex end-to-end run is M3, not M1.
