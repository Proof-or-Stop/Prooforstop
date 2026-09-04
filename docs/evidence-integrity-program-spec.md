# Evidence Integrity & Convergence — Program Spec

Status: DRAFT for review · Date: 2026-07-25 · Author: jek + Claude (brainstorming)
Supersedes the single-feature "evidence-write-guard" spec (rev 1–3, all retracted).
Re-aimed after four cross-host audits (Codex + Agy on the design; Codex + Claude
CLI on the requirement — the Claude CLI pass read the actual B-bf52 burn ledger).

## 0. What the requirement audits established

The original ask — "the agent keeps breaking its own process rules; move
enforcement out of memory and into the tooling (via PreToolUse on both hosts)" —
was aimed, after two design audits, at the *lowest-value* target (a narrow
`quorum_submit` duplicate patch). Two independent requirement audits re-ranked the
real pain, and the ledger-reading pass corrected several assumptions:

- **Priority: class 1 (evidence-binding) ≫ class 3 (runaway rounds) > class 2
  (redundant quorum).** Class 2 happened once and self-recovered; class 1 produced
  ~1/3 of the burn's findings and is the *engine* of class 3.
- **Class 1 is an interface defect, not a discipline defect.** `verificationIntent`
  stores no command/selector (types.ts:203-212); the only binding predicate is
  `evidence.intentRef === ref` (verification.ts:46-48). The tool asks the agent to
  assert a semantic match it cannot mechanically check, then trusts it.
- **The proof unit is `(command, selector)`, not `command`.** 16 of 19 evidence
  records in the burn shared one command; what distinguished intents was a *case
  name* in free-text notes that nothing checked. A bare `expectedCommand` field
  would not have caught F-045/F-061.
- **`verification_evidence_refresh_stale` launders stale assertions.** Its CLI help
  says "(rerun command)" but the impl (checklist.ts:1051-1077) copies
  `command`/`result`/`note` verbatim and only re-stamps the hashes — it never
  executes anything. It re-certifies unverified `pass` onto new material.
- **Class 1 causes class 3.** Each evidence-defect finding → fix commit →
  whole-tree `materialHash` change → that round's review bindings invalidate → new
  round → manual re-record of ~19 evidence rows → new evidence defects. Fixing
  class 1 removes a large fraction of class 3's rounds; a round cap does nothing
  for class 1.

## 1. The two mechanisms (cover all three classes)

- **M1 — tool-executed, selector-bearing evidence receipts.** The tool runs the
  declared verifier and stamps the result; the agent never authors the command.
  Covers the whole class-1 family + re-attestation of frozen fields / doc promises
  + shrinks class 3 (rework is no longer hand-recorded, so it stops minting new
  defects).
- **M2 — promote "already satisfied" and "not converging" from advisory to hard
  state at the write point.** Class 2 becomes an idempotent no-op (including
  `autopilot_review_submit`, which today has no duplicate guard at all); class 3's
  stall detector becomes a mandatory adjudication point. The retracted rev 3 was a
  special case of a subset of M2.

## 2. Where PreToolUse lands (honestly)

The original ask. It stays — as a *seatbelt*, not the enforcement floor. The
threat model is a cooperating-but-fallible agent (not an adversary), so a
fail-open hook that intercepts the standard invocation and blocks with a teaching
message is genuinely useful. But M1 is stronger than a seatbelt for class 1: when
the tool runs the verifier and stamps the receipt, a false command cannot be
authored *at all* — the error becomes impossible, not merely caught. So: **M1/M2
(handler + lifecycle gate) are the floor; PreToolUse is an optional early-warning
layer** for both hosts, added only where it adds signal and only after an e2e test
confirms each host's real shell tool name.

## 3. Implementation order (cheapest first; each ships independently)

### Step 1 — stop the laundering + reject self-contradictory evidence rows
*(near-zero cost, no schema change; directly kills F-049/F-050)*
- `verification_evidence_refresh_stale`: EITHER actually re-execute the pinned
  command and re-issue a receipt, OR rename it and make explicit it only refreshes
  hashes and CANNOT clear an evidence-freshness gate. Not the current worst-of-both.
- Add a mechanical "evidence row internally self-contradictory → reject" check:
  when a row's `command` names target A while its own `file` field names a
  different target B, refuse the write. F-049 (`command`→`gate-repeat-block-smoke.js`,
  `file`→`convergence-breaker-smoke.ts`) and F-050 are caught today, in-row.

### Step 2 — pin `(command, selector)` and make the tool execute it
*(the core class-1 fix; M1)*
- Add `verification: { command, selector }` to the intent item (precedent:
  `plannedPathDeclarations`, types.ts:225-232). PINNED on the first evidence write
  for that intentRef, immutable thereafter — so PLAN-time need not know the command
  (intent freezes from DEV: checklist.ts:653), yet later drift is mechanically
  impossible.
- `verification_evidence_add` for automated intents no longer accepts a
  caller-authored `command` + `result`; it executes the pinned command
  (via the existing `validation-executor.ts:303` spawn path) and refuses when:
  (a) exit code ≠ 0 but `pass` claimed; (b) `selector` string absent from captured
  output (kills F-045 non-existent case, F-049/F-050 wrong suite, F-061 wrong case);
  (c) `intentRef` does not resolve to an intent on that item (today silently
  accepted, checklist.ts:928); (d) pinned command ≠ command to run (error using the
  existing `receipt-command-mismatch: expected X, got Y` convention). Receipt stores
  `exitCode` + `outputDigest` + `outputTail`.
- `type: 'manual' | 'docs'` intents stay attestation-only, explicitly marked
  non-mechanical, and must NOT score equal to tool receipts (else `type:manual` is
  an escape hatch).

### Step 3 — stall detection becomes a blocking adjudication
*(class 3; M2)*
- The existing stall detector (`review-convergence.ts`, STALL_MIN_ROUNDS=4 /
  STALL_WINDOW=3) is advisory-only (`transition-effects.ts` try/catch, "never
  block"). On trigger, require an explicit adjudication before another ordinary
  review round is minted: human-authorized continue (reason + bounded budget) /
  re-plan / record root-cause escalation / declare a checklist item unreachable.
  The goal is to surface "are we converging, or is this task ill-posed?" early —
  the real loss in the burn was 12 rounds to discover CHK-003 was unreachable
  (F-058), not the round count itself.

### Step 4 — duplicate handling across host-verdict writers
*(class 2; M2 — subsumes retracted rev 3, more completely)*
- **Delivered (B-3144, `handlers/quorum-submit.ts` `assertNoStandingQuorum`)**:
  a redundant re-submit (same material, or stale material with matching
  storyFilesHash — the drift-accept case) is refused with an informative
  `Error`, not silently absorbed as an idempotent no-op. Downgrade-aware, but
  the predicate is a hand-synced LOCKSTEP mirror of
  `eventsWithStoryFilesHashDowngrade` rather than a direct call-through (the
  guard runs pre-commit on a boolean "would this collide" check, not on the
  post-commit event-rewrite the floor helper performs) — the guard's own
  comment flags that a future change to the floor's drift-accept predicate
  must update this mirror in the same story, or producer/consumer parity
  breaks silently.
  - **Known gap, not yet done**: `autopilot_review_submit` (`verdict.ts:187-251`)
    remains unguarded — B-3144 scoped only `quorum_submit`. A fast-follow
    would extend the same guard there.

## 4. Success metrics (against the observed incidents)

- Zero evidence records whose execution receipt does not match the referenced
  intent's pinned `(command, selector)`.
- Repeated submission of the same logical quorum/verdict leaves the ledger
  unchanged (idempotent).
- No story exceeds the configured review budget without a recorded escalation /
  override.
- All host-verdict writers, both evidence paths, aliases, and direct
  `node bin/proof-or-stop.js` invocation reach the same enforcement boundary.

## 5. Open items for the story sequence

- Migration: existing prose-only intents need grandfathering / an audited repair
  path / a policy mode.
- Escape semantics: manual evidence and emergency overrides must be explicit,
  attributable, and visible to gates.
- Frozen-field / doc-promise drift (F-027/F-060 `userSees`, F-059 plan.md) is the
  same super-class as class 1 ("an artifact asserts a fact about code; nothing
  re-checks after code changes") and can reuse M1's re-attestation. Track as a
  follow-on once M1 exists.

## 6. Implementation path

Each step is its own Proof-or-Stop story (audit trail), cheapest first. Step 1 opens
now. Steps touch evidence integrity, so they are high-assurance and go through full
cross-host quorum review themselves — dogfooding.

## 7. Frozen review inventory boundary

Review discovery now has a signed, gate-consumed frozen-candidate boundary.
`review-inventory-epochs.json` binds material/story-files hashes, scope, review
round, required lanes, wave evidence and the verified finding-set digest. An
OPEN epoch rejects material writes at the prewrite projection and every
authoritative reviewer evidence/finalize/transition consumer revalidates the
cutoff. A zero-new-finding saturation receipt authorizes one aggregated
REVIEW→DEV remediation only; it explicitly cannot authorize TEST or certify the
repaired material. See
`docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md`.
