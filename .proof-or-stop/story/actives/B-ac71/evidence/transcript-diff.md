# B-ac71 — Real-machine acceptance transcript & diff (TEST)

Story: Tier-C cross-host quorum M0 — threat-model + execution-plan decision docs (docs-only).
Rhythm: PLAN outcome = **expected** → run on real machine → **actual** → **diff**.

This is a documentation deliverable, so "user value" acceptance = a reader/skeptic can open the
two docs and find (a) every promised section, (b) no over-claimed independence wording, (c) no
milestone-label collision. Each is verified below by a command actually run in the worktree.

---

## CHK-001 — threat-model doc

**Expected (PLAN):** `tier-c-crosshost-quorum-threat-model.md` finalized with: trust anchor
(pinned manifest, verify-against-pinned-not-self), independence definition + honest ceiling
(cross-vendor, same-operator), the fail-closed rule table (→ future M1/M2 RED tests), and key
gen/pin/rotate/revoke.

**Run + actual:**
- `grep -nE "pinned|out-of-band|Independence|ceiling|cross-vendor|fail-closed|rotation|revocation|generateEd25519KeyPair"` → **26** matching lines across §2–§5 (all five §6 acceptance topics present in body).
- §6 acceptance checklist items (trust anchor / independence + ceiling / fail-closed table / key lifecycle / M5 wording boundary) each map to a body section.

**Diff:** none — every PLAN-promised section is present.

## CHK-002 — execution-plan doc

**Expected (PLAN):** `tier-c-crosshost-quorum-execution-plan.md` finalized with the 6-milestone
M0–M5 plan and the cheap proof-of-mechanism block (M0–M3) split from the expensive powered run (M4).

**Run + actual:**
- `grep -nE "^### M[0-5] "` → **6** headings present: M0 (threat-model doc), M1 (signed-verdict
  provenance), M2 (cross-host collection), M3 (proof-of-mechanism run), M4 (powered campaign),
  M5 (paper flip).
- §2 states the cheap (M0–M3) vs expensive (M4) split and the 2026-07-02 decision to do M0–M3 first.

**Diff:** none — all six milestones present, split documented.

---

## Adversarial acceptance (the two prior-round findings + the low residual)

**F-001 (independence over-claim) — expected: forbidden phrases absent as assertions.**
`grep -rEc "mutually-distrusting parties|fully independent hosts|zero-trust multi-party|trustless multi-party|mutually-distrusting vendor"`
- execution-plan.md → **0**
- threat-model.md → **1**

Diff vs expected (zero *assertions*): the single threat-model match is at §3 line 36, **inside the
forbidden-phrases definition list** ("forbidden = \"mutually-distrusting parties\" / \"no operator
trust required\"") — a meta-use naming the phrase as prohibited M5 wording, not a claim about the
system. This is the intended and correct occurrence; no assertive over-claim remains.

**F-002 (milestone-label collision) — expected: zero bare autopilot M-numbers.**
`grep -rnE "autopilot M[0-9]|M[0-9]/M[0-9].*throttle|M1 \(checkpoint"` on execution-plan.md → **0 lines**.
Autopilot capabilities are now named (checkpoint/resume, 429/network health-aware pause/resume,
adaptive-throttle, process-pool parallelism); the sole remaining "M4" is qualified "Tier-C milestone M4".

**F-003 (evidence-note specificity) — expected: the CHK-001:adversarial:0 note documents the
literal-grep-vs-meta-use resolution.** The note (commit aaf994e) records the exact grep, the 4×0 /
1×meta-use outcome, and the 367b05322 removal of the prior real over-claim. Confirmed closed by the
test-coverage lane's own independent grep (RP-007).

---

## Validate

`lattice validate --story=B-ac71` → PASS: `npm --prefix packages/main run build` + 10 configured
smoke suites all green (retired-authority-vocabulary-guard, capability-list, review-pass-discard,
init-window-data-loss, validate-command-timeout [18 assertions], validate-focused-full-layering
[10 assertions], main-sync-readiness, codex-adapter-gate-scope, delivery-check-freshness, …).

## Verdict

All PLAN-promised content delivered; all three findings from the prior REVIEW round confirmed
resolved by real-machine re-run; validate green. Docs-only story is user-acceptable: a skeptic
opening either doc finds the promised structure and no over-claim.
