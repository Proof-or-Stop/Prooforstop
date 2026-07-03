# Tier-C Cross-Host Quorum — Execution Plan

Status: draft for human review (2026-07-02)
Scope: close the paper's sole open evidence tier (Tier-C strong host-neutral) as a CLI-only,
no-server cross-host signed-quorum capability, then measure it.
Foundation note: this is part of the locked "coding + Tier-C = foundation" priority; domain packs
are gated above this and stay at proposal until this is solid.

## 0. Current state (code-verified, CLI-only, no server)

The Authority Python server is deprecated; the system is CLI-only (the CLI signs receipts and
verifies them offline). Verified against the current CLI:

- **Built and working:** local Ed25519 signing + offline verify (`receipt-bundle.ts`
  `buildReceiptBundle` / `verifyReceiptBundleOffline`; `authority-signing.ts` sign/verify canonical);
  a pure quorum evaluator (`decision-doc-quorum.ts` 3-round × 2-host, strict `materialDigest`;
  `verdicts.ts` `summarizeVerdicts` union-find, fail-closed; `quorum-submit.ts` handler).
- **The three gaps (why Tier-C is not closed):**
  1. **Provenance:** the `HostVerdict` record has NO required signature (`verdicts.ts`; a carried
     `receiptId` is explicitly "not a verified signature"). A verdict proves tree integrity
     (materialHash) but NOT that it came from a specific host's key.
  2. **Independence is a label, not crypto:** `quorum-submit.ts` derives host/session/key from
     string templates and only rejects string collisions. Two "independent" hosts in one store is a
     naming convention, not two signed attestations.
  3. **No cross-host collection:** `dispatch_auto` picks ONE host; non-Claude hosts (Codex) are
     supervised-only/scaffolded — Proofbound does not auto-drive host B or collect its signed verdict.
- **Not covered by pre-reg:** the locked `lattice-experiment-protocol.md` has H1/H2/H3 only; a
  cross-host quorum-formation hypothesis (H4) must be added by amendment.
- **Autopilot:** checkpoint/resume + 429/network health-aware pause/resume are production;
  adaptive-throttle + process-pool parallelism are gated — needed only for the powered campaign
  (Tier-C milestone M4 below), and the proven `experiments/recovery-runner/powered/` scaffolding can
  substitute. (Autopilot's own internal milestones are named by capability here to avoid colliding
  with this plan's M0–M5.)

## 1. What this closes and what it proves

Today all evidence (Tier-A engine contract, Tier-B powered ablation) is produced on one operator's
machine — a skeptic must trust the operator. Tier-C makes two **independent vendor hosts**
(Claude + Codex) each emit a **cryptographically signed** verdict on the same code, such that any
third party can **offline-verify** both signatures and their binding to that exact code. It moves
trust from "trust the operator" to "trust the math + two independent vendors." This is the strongest
form of the thesis and the sole gap the paper names for Tier-C.

## 2. Milestones

Cheap proof-of-mechanism = M0–M3 (days each, ~zero research risk). Expensive strong claim = M4
(the powered run, real spend). Paper flip = M5. Decision (2026-07-02): do M0–M3 first; M4 only when
a strong external claim is actually needed.

### M0 — Threat model + key-management decision doc  [doc · small · high-leverage]
Objective: define, before any run, what makes the quorum sound.
- How host A trusts host B's signing public key (a pinned `[hostId → publicKey]` manifest; out-of-band).
- The **independence definition** and its honest boundary: cross-vendor (different companies/models)
  vs. same-operator orchestration — the paper may only claim what the setup earns.
- Replay / stale-materialHash / supersession defenses; key rotation/revocation.
Deliverable: `docs/requirements/decisions/tier-c-crosshost-quorum-threat-model.md`.
Acceptance: names the trust anchor, the independence claim + its ceiling, and every fail-closed rule.
Repro-first: exempt (documentation, not material code).

### M1 — Automatic cross-host review + disagreement surfacing (crypto-deferred)  [build · medium · the mechanism crux]
Decision (2026-07-03): M1 is **crypto-deferred**. On the current single-machine, same-operator
setup, tamper-proofing (signed verdicts / pinned keys) defends against a non-existent adversary —
the value we can earn today is the **adversarial joint decision**, not a signature. So M1 builds the
collection+decision mechanism now and defers the provenance crypto to M-crypto (below,
external-skeptic-only).
Objective: turn the manual 2-host quorum into an **automatic** cross-host adversarial review that
records a materialHash-bound host-B verdict through the existing capture path and surfaces where
host A (Claude) and host B (Codex) disagree.
- A new `cross_host_review` command auto-runs Codex as an independent **read-only** reviewer over the
  current materialHash-bound change (stdin-piped `codex exec -s read-only -C <worktree>`; parse ONLY
  the structured JSON verdict, record only a `stdoutDigest` for provenance — never raw stdout).
- Fail-closed: no parseable/schema-valid verdict → `blocked` (`codex_review_no_parseable_verdict`);
  a verdict bound to a different materialHash → `blocked` (`codex_review_material_mismatch`).
- Capture the host-B verdict via the existing `submitLocalVerdict` path (binds `materialDigest`,
  appends a `host_verdict` event) with a distinct derived hostId/session/key so the two hosts do not
  collapse in `groupByIndependentHost`.
- `diffFindings` + `jointDecision` (pure): the joint decision is `pass` IFF both hosts pass AND there
  is no finding-level divergence; otherwise `blocked`, surfacing WHICH finding one host raised and the
  other missed (the gap `summarizeVerdicts` does not fill — it only counts pass/fail hosts).
- Dispatch policy gains a NARROW `allowReviewOnlyRealHostSubprocess` flag that permits ONLY a
  read-only Codex reviewer; the general `allowRealHostSubprocess` implementation path for codex, and
  gemini/antigravity, stay refused.
Files: `core/codex-review-leaf.ts` (new), `core/cross-host-review.ts` (new),
`handlers/cross-host-review.ts` (new), `core/dispatch-policy.ts`, `cli/command-catalog.ts`,
`registry.ts`. Crypto files (`receipt-bundle.ts`/`authority-signing.ts`) are explicitly **untouched**.
Acceptance: with an injected fake Codex seam, a `fail` verdict carrying a host-B-only finding yields
`jointDecision === 'blocked'` with `disagreement.onlyHostB.length === 1`; an agreeing case (both pass,
identical findings) yields `jointDecision === 'pass'`, `hasDisagreement === false`; both fail-closed
paths return a synthesized `blocked` verdict and never surface raw stdout.
Repro-first RED: `registry.get('cross_host_review')` FAILS on the pre-fix baseline. SPIKE (done):
codex 0.141.0 emits the verdict JSON cleanly only via the stdin-pipe read-only mechanism (prompt-as-arg
hangs; there is no `--prompt-file`).

### M-crypto — Provenance: signed verdict + public-key pinning  [build · medium · external-skeptic-only, DEFERRED]
Deferred (2026-07-03): only worth building when a strong EXTERNAL-skeptic claim is actually needed
(pairs with M4's powered campaign). On the current same-operator setup it defends against no present
adversary, so it is explicitly moved out of the near-term M0–M3 block.
Objective: make each verdict cryptographically bound to a distinct pinned host key.
- Each host emits a `receipt-bundle`-signed verdict; bind the signature INTO the `HostVerdict` record.
- Add the pinned `[hostId → publicKey]` manifest.
- Upgrade `summarizeVerdicts` independence from label-distinct to signature-distinct (verify two
  different pinned keys).
Files: `verdicts.ts`, `receipt-bundle.ts`/`authority-signing.ts`, new manifest.
Acceptance: a quorum is valid only if it carries two verdicts signed by two different pinned keys
over the same materialHash; a hard-recompute/full-verify fallback keeps admissibility un-relaxed.
Repro-first RED: two label-distinct verdicts signed by the SAME key (or unsigned) must NOT form a
quorum. SPIKE: signature verification distinguishes them; byte-identical evaluator output otherwise.

### M2 — Collection: cross-host dispatch-verify verb + handshake  [build · medium]
Objective: actually collect host B's signed verdict, no server.
- A `dispatch_verify`-style path: send the same materialHash-bound change to host B (Codex CLI),
  capture its signed verdict from the dispatch result, merge into the quorum store.
- materialHash handshake: both hosts review the identical tree state before either submits.
Files: `lattice-dispatch.ts`, `quorum-submit.ts`.
Acceptance: one command drives host B and returns a verifiable signed verdict bound to the same
materialHash as host A's; freshness check passes for both.
Repro-first RED: a verdict over a drifted/different materialHash must be rejected at merge. SPIKE:
handshake blocks submission until both hosts are on the same tree sha.

### M3 — Proof-of-mechanism: one live 2-host signed quorum  [run · small]
Objective: prove the chain end-to-end once.
- Host A (Claude) + host B (Codex) independently review one real change; each emits a signed verdict;
  a verifiable 2-host quorum forms; `multi_host_gate_satisfied = true`.
- Capture a full non-stub transcript (job/run/evidence refs, both verified signatures).
Acceptance: a third-party offline verify of the captured bundle passes with two distinct pinned keys.
Milestone value: the paper's host-neutral claim moves from "gated" to "mechanism shown, offline-verifiable."

### M4 — H4 pre-reg + powered cross-host campaign  [run · large · dominant cost]
Objective: turn the mechanism into a rate with a CI. (Do only when a strong external claim is needed.)
- H4 pre-reg amendment: quorum-formation rate + CI; n for a binomial CI; corpus (reuse the 24-task
  stratified set after a host-agnosticism audit); independence definition; stop-rule.
- Powered run: N cases × {host A, host B} × k; measure quorum-formation rate + CI, cross-vendor
  agreement rate, and the cross-vendor marginal-finding rate.
- Reliability: autopilot checkpoint/resume + health-aware pause/resume (production) + the recovery-runner `powered/` scaffolding.
Acceptance: a pre-registered, matched-cell rate with a Wilson/bootstrap CI, honestly reported even if
modest or noisy.
Risk: real spend + the rate may be unimpressive (two independent vendors can disagree) — report as-is.

### M5 — Paper flip  [edit · small · last, evidence-bound]
Objective: promote Tier-C in the paper once earned.
- `tab:tier` Tier-C row `\gat` → `\ver` with the powered rate (after M4) — or a "mechanism shown"
  softening after M3 only.
- Update abstract/conclusion; relax the prohibited-wording guard ONLY for the earned claim.
Files: `lattice-Paper/paper/main.tex`.

## 3. Dependencies & sequence
M0 → M1 (crypto-deferred cross-host review) → M2 → M3 → (stop / decide) → M-crypto → M4 → M5.
M0 can run in parallel with M1 design. The M0–M3 block is the committed near-term scope; the
provenance crypto (M-crypto) and the powered campaign (M4) are separate, external-skeptic-only
go/no-go decisions taken together.

## 4. Non-goals
- No central server / no remote proof service (CLI-only by design; Eq.adm unchanged).
- No cryptographic provenance in the near-term M0–M3 block (signed verdicts / pinned keys are the
  DEFERRED, external-skeptic-only M-crypto; M1 records materialHash-bound verdicts, not signatures).
- Do not over-claim independence beyond cross-vendor (state the same-operator boundary — the honest
  ceiling is "cross-vendor independent, same-operator orchestrated; not a Byzantine multi-party
  trust claim", per the threat model §3).
- Do not flip `tab:tier` before the evidence exists (M5 is last).

## 5. Lattice story sequence (all via the story workflow)
1. M0 threat-model doc — story (docs; repro-first exempt).
2. M1 automatic cross-host review + disagreement surfacing (crypto-deferred) — story B-f57a
   (material code; repro-first RED/SPIKE done).
3. M2 cross-host collection — story (material code; repro-first required).
4. M3 proof-of-mechanism run — story (run + captured transcript evidence).
(4') Decide go/no-go on M-crypto + M4 together (external-skeptic-only). M-crypto/M4/M5 are separate
stories opened only if pursued.
