# Step 2 handoff — Tool-executed evidence receipts + PreToolUse seatbelt (fixes class ①, the heart)

Audience: a fresh session picking this up cold. This is self-contained. Parent
program: `docs/evidence-integrity-program-spec.md`. Step 1 (`B-3b88`) is a small
precursor; THIS is the real fix for the most frequent failure (evidence-binding
mismatch).

## 1. The problem (class ①)

When recording verification evidence, the agent authors a `command` + `result:pass`
that the tool cannot mechanically check against the checklist item's declared
intent, and the tool trusts it. This produced F-049/F-050 (wrong command), F-045
(cited a case that does not exist), F-061 (cited the wrong case within the right
command) — repeatedly, across sessions. It is an interface defect, not a discipline
defect: there is nothing to compare against.

Evidence (verified against real code):
- `core/types.ts:203-212` — `VerificationIntentItem` has `id/desc/type/requiredIn/
  priority/plannedPathDeclarations`. **No command or selector field.**
- `core/verification.ts:46-48` — `evidenceMatches(evidence, ref)` is
  `evidence.intentRef === ref`. **The only binding predicate is intentRef string
  equality.**
- `handlers/checklist.ts` (verification_evidence_add) — accepts an arbitrary
  optional `command` and `result`; validates note/kind/waiver/item-existence/hashes
  only. A row's `intentRef` is not even checked to resolve to a real intent on that
  item (`checklist.ts:928` finds it only in the *evidence* array).
- The proof unit is `(command, selector)`, not `command`: in the B-bf52 burn 16 of
  19 evidence rows shared one command; what distinguished intents was a case name in
  free-text notes that nothing checked. **A bare `expectedCommand` field is
  insufficient.**

## 2. The fix — the tool executes and stamps the receipt

The agent must not author a pass command at all. The tool resolves the intent,
runs the declared verifier, and stamps a receipt. A false command becomes
impossible, not merely caught.

### 2a. Schema: pin `(command, selector)` on the intent
Add to `VerificationIntentItem` (precedent: `plannedPathDeclarations`,
types.ts:225-232 — structured declarations already hang off an intent item):

```
verification?: {
  command: string;      // executable + argv, NOT a raw shell program
  selector: string;     // test id / case name / assertion string that MUST appear in output
  // optional: cwdPolicy, expectedExit, specDigest
}
```

Constraint: the intent is frozen from DEV (`handlers/checklist.ts:653`, refuse at
`:677-681`), and at PLAN the implementation does not exist yet — so this cannot be
required at PLAN time. **Pin it on the FIRST evidence write for that intentRef and
make it immutable thereafter.** No PLAN-time foreknowledge needed; later drift
becomes mechanically impossible.

### 2b. `verification_evidence_add` executes instead of trusting
For automated intent types (`logic|cli|integration`), stop accepting a
caller-authored `command`+`result`. Instead run the pinned command and refuse the
write when ANY of:
- (a) exit code ≠ 0 but `pass` is claimed;
- (b) the `selector` string is absent from captured output — this single check
  kills F-045 (non-existent case), F-049/F-050 (wrong suite), F-061 (wrong case);
- (c) `intentRef` does not resolve to an intent on that item (today silently
  accepted, `checklist.ts:928`);
- (d) the pinned command ≠ the command about to run — error with the existing
  `receipt-command-mismatch: expected X, got Y` convention.
The receipt stores `exitCode` + `outputDigest` + `outputTail` (this also gives
reviewers real numbers, killing the "claimed 12, actually 20" counting errors from
F-013).

### 2c. Preferred ergonomic form — `verification_run`
Add `proof-or-stop verification_run --storyId … --intentRef …` that resolves the intent,
executes its declared verifier, captures exit/output metadata, and atomically
writes the evidence. Ideally `verification_evidence_add` should not accept a
caller-authored command for automated proof at all — it accepts a receipt id or an
internally-generated result. Make the correct action the path of least resistance.

### 2d. Manual / docs intents
`type: manual | docs` cannot auto-execute. Keep them as attestation, but mark them
explicitly "human attestation, non-mechanical" and DO NOT score them equal to tool
receipts at the gate — otherwise `type:manual` is an escape hatch that bypasses the
whole mechanism.

## 3. Existing building blocks to reuse (do NOT reinvent)

All verified present in the tree:
- `core/validation-executor.ts:303-392` — `spawn`, isolated process group, timeout
  normalized to exit 124, captures stdout+stderr. This is the executor.
- `core/done-required-validation.ts:884-909` — already produces a tool-owned
  receipt whose fields are exactly what evidence lacks: `exitCode`, `outputDigest`,
  `outputTail`, `commandSpec` envelope. Model the evidence receipt on this.
- `handlers/live-smoke-transcript.ts` (`--capture`, ~lines 26-28) — runs ONLY the
  explicitly given command; comment states it "never derives or appends commands".
  Reuse its discipline.
- `core/proof-or-stop-dispatch.ts:1732-1738` — rejects non-allowlisted commands before
  execution. Reuse for the executor allowlist.
- Mismatch error convention already exists: `done-required-validation.ts:701`
  (`receipt-command-mismatch: expected X, got Y`) and `core/repro-intake.ts:310-316`
  (fail-closed `command mismatch`).

## 4. The PreToolUse seatbelt (the layer originally asked for)

Threat model: a cooperating-but-fallible agent, NOT an adversary. So a fail-open
hook that intercepts the standard invocation and blocks early with a teaching
message is genuinely useful — as a SEATBELT, not the enforcement floor (that is
§2, in the handler).

- Both hosts, mirroring the existing scope guard: thin `.cjs` shim →
  `spawnSync` a read-only CLI verdict command (like `prewrite_guard_check`). Claude
  matcher adds `Bash`; Codex `.codex/hooks.json` adds its shell-tool matcher.
- On `verification_evidence_add`, the shim forwards the raw command string; the CLI
  verdict command parses it and denies (`exit 2`) if the `--command`/`--selector`
  does not match the pinned intent — before the write runs.
- **Fail-open is fine here** because §2 (the handler) is the real floor.
- **Gate the Codex side on an e2e test** that uses Codex's actual emitted shell tool
  name (the current Codex matcher is `apply_patch|Edit|Write`, which does NOT match
  shell execution — confirm the real token or the hook never fires).

## 5. Acceptance criteria / success metrics
- Zero evidence records whose execution receipt does not match the referenced
  intent's pinned `(command, selector)`.
- A row asserting `pass` whose command exits non-zero, or whose selector is absent
  from output, is refused.
- `intentRef` that does not resolve to an intent on the item is refused.
- Both single (`verification_evidence_add`) and batch evidence paths, plus direct
  `node bin/proof-or-stop.js` invocation, reach the same enforcement boundary.
- Reviewers see real `exitCode`/`outputDigest`/`outputTail`, not prose claims.

## 6. Migration & escape semantics (do not skip)
- Existing prose-only intents: grandfather, or provide an audited repair path, or a
  policy mode. Do not hard-break stories mid-flight.
- Manual/emergency overrides must be explicit, attributable, and visible to gates,
  or callers will route around an over-rigid schema.
- `verification_evidence_refresh_stale` must not re-certify by copying freshness
  fields. A current `VerificationReceiptBundleV5` from the policy-owned deterministic
  capsule may publish a signed `ReuseReceipt` with zero subprocesses only when its
  complete input closure, `evidenceInputDigest`, execution identity, and signed lineage
  still validate. Otherwise affected rows are grouped by selector-free execution key,
  the pinned command is really run at most once per affected execution key, and any
  uncertainty or failed execution fails closed and demotes the dependent evidence.

## 7. How to start
1. Read `docs/evidence-integrity-program-spec.md` §1 (M1) and §3 Step 2.
2. `cd /Users/jek/Documents/Work/proofbound`; `proof-or-stop session_brief`; check for an
   existing story on this before creating (`proof-or-stop story_list`).
3. `proof-or-stop story_create` (type=feature, this adds a schema field + new command;
   likely high-assurance → full cross-host quorum review). Background must cite
   F-049/F-050/F-045/F-061 + a date. Split into ≥2 stories if large: (i) schema +
   pinned binding + refuse-on-mismatch; (ii) `verification_run` ergonomic command;
   (iii) PreToolUse seatbelt.
4. RED test first: an evidence row with a selector absent from output must be
   refused after the fix and (demonstrably) accepted before it.
