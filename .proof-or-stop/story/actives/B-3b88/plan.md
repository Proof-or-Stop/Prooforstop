# Plan — B-3b88 evidence-selfcheck-refresh-honesty

Two mechanical, zero-schema fixes that remove ways false verification evidence
enters the ledger. Both live in `packages/main/src/handlers/checklist.ts`; a pure
helper may live in `packages/main/src/core/verification.ts`.

## CHK-001 — Reject an evidence write whose command and file fields name contradictory targets

**Goal (user-observable):** `verification_evidence_add` refuses, with an explicit
error, an evidence row whose own `command` and `file` fields point at different
targets. Kills F-049 (command→`gate-repeat-block-smoke.js`, file→
`convergence-breaker-smoke.ts`) and F-050 (same shape).

**Mechanism:**
1. Add a pure helper (core/verification.ts), e.g. `detectEvidenceRowContradiction(row)`,
   returning a reason string or null.
2. It compares the primary target file referenced by `command` against the `file`
   field. Extract the command's target-file stem: the last path-like argument that
   ends in `.js`/`.ts`/`.cjs` (e.g. `node packages/main/dist/tasks/X.js` → `X`),
   normalizing `dist`↔`src` and `.js`↔`.ts`. Compare its basename stem to the
   `file` field's basename stem.
3. If BOTH `command` and `file` are present AND both yield a file stem AND the stems
   differ → contradiction → refuse.
4. Wire the helper into `verification_evidence_add` before persistence; throw a
   clear error naming both fields and both stems.

**Edge cases / no false positives:**
- `command` with no file-like argument (e.g. `npm test`, `lattice validate`) →
  cannot derive a stem → no contradiction → allow.
- `file` absent, or `command` absent → allow.
- Same stem via dist/src or .js/.ts spelling → NOT a contradiction (normalize).

**RED test (`tasks/evidence-selfcheck-smoke.ts`):** a fixture row
{command:`node dist/tasks/gate-repeat-block-smoke.js`, file:`.../convergence-breaker-smoke.ts`}
is refused after the fix; a matching-stem row is accepted; a `npm test` row (no
stem) is accepted.

## CHK-002 — Stop verification_evidence_refresh_stale from re-certifying pass evidence without re-execution

**Goal (user-observable):** `refresh_stale` no longer silently marks a stale,
command-backed `result:pass` row as fresh on changed material. It either re-runs or
refuses; the current behavior (copy command/result/note verbatim, re-stamp hashes,
never execute — checklist.ts:1051-1077) is the laundering channel that produced
F-045/F-046/F-047.

**Mechanism (minimal, no execution pipeline — that is Step 2):**
1. In the refresh loop, classify each stale row: if it has a non-empty `command`
   AND a passing `result`, it is a command-backed pass.
2. For command-backed pass rows: DO NOT re-stamp. Leave the row stale and report it
   in the output as "requires real re-verification (re-run via
   verification_evidence_add); refresh will not re-certify an unexecuted pass."
3. Only rows WITHOUT a command (pure attestation / manual / waiver / docs) keep the
   existing freshness-hash refresh.
4. Adjust the summary line + the command help ("(rerun command)") so the documented
   semantics match: refresh refreshes attestation freshness only; it does not
   re-certify command-backed proof.

**Edge cases:**
- Command-backed non-pass rows (blocked/waived): out of scope for this slice — the
  laundering risk is specifically re-certifying a PASS. Keep the change tight to
  passing rows; note the rest as a Step-2 follow-on.
- Dry-run path unchanged except it reports which rows would be refused vs refreshed.

**RED test (`tasks/refresh-stale-honesty-smoke.ts`):** a stale command-backed
`result:pass` row is left stale (not refreshed) after the fix; before the fix the
same row is refreshed. A stale attestation row (no command) is still refreshed.

## Out of scope (see scope boundary)
- `(command, selector)` schema binding + tool-executed receipts → Step 2
  (`docs/step2-evidence-receipts-handoff.md`).
- Stall-adjudication breaker → Step 3 (`docs/step3-review-budget-breaker-handoff.md`).
- quorum/autopilot idempotency → B-3144.
