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
- **Autopilot:** M1 (checkpoint/resume) + M2 (429/network health-aware) are production; M3/M4
  (throttle, process-pool) are gated — needed only for the powered run (M4 below), and the proven
  `experiments/recovery-runner/powered/` scaffolding can substitute.

## 1. What this closes and what it proves

Today all evidence (Tier-A engine contract, Tier-B powered ablation) is produced on one operator's
machine — a skeptic must trust the operator. Tier-C makes two **mutually-distrusting vendor hosts**
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

### M1 — Provenance: signed verdict + public-key pinning  [build · medium · the technical crux]
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
- Reliability: autopilot M1/M2 (production) + the recovery-runner `powered/` scaffolding.
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
M0 → M1 → M2 → M3 → (stop / decide) → M4 → M5. M0 can run in parallel with M1 design.
The M0–M3 block is the committed near-term scope; M4 is a separate go/no-go.

## 4. Non-goals
- No central server / no remote proof service (CLI-only by design; Eq.adm unchanged).
- No new evidence type beyond signed cross-host verdicts.
- Do not over-claim independence beyond cross-vendor (state the same-operator boundary).
- Do not flip `tab:tier` before the evidence exists (M5 is last).

## 5. Lattice story sequence (all via the story workflow)
1. M0 threat-model doc — story (docs; repro-first exempt).
2. M1 signed-verdict provenance — story (material code; repro-first RED/SPIKE required).
3. M2 cross-host collection — story (material code; repro-first required).
4. M3 proof-of-mechanism run — story (run + captured transcript evidence).
(4') Decide go/no-go on M4. M4/M5 are separate stories opened only if pursued.
