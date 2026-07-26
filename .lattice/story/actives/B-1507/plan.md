# Plan: B-1507 Add a verification_run command, re-execute the stale-evidence refresh, and add a fail-open PreToolUse evidence-pin guard

Ergonomics + seatbelt layer on top of the B-ec67 enforcement floor (DONE, CLI 0.3.240). Reuse `enforceAndStampEvidence` (checklist.ts:497) and `runSingleAllowlistedCommand` (validation-executor.ts) — do not add a second executor. Coordinate additively with B-3b88 on the shared `verification_evidence_refresh_stale` function.

**DEV ordering note:** CHK-001, CHK-002, CHK-003 all write to `handlers/checklist.ts` and/or `cli/command-catalog.ts` (overlapping write sets), so they are dispatched **serially** (fresh implementer per item), not in parallel. CHK-004 depends on all three.

---

## CHK-001: Add a verification_run command that resolves the intent, executes the pinned verifier, and atomically writes the receipt

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/cli/command-catalog.ts (register `verification_run`, schema `{storyId, itemId?, intentRef, note?, cwd?}`, near verification_evidence_add at :453)
- Modify: packages/main/src/handlers/checklist.ts (add `verification_run` handler; resolve the intentRef → its pinned `verification:{command,selector}` → call the SAME `enforceAndStampEvidence` with `runCommand: (c,cwd)=>runSingleAllowlistedCommand(c, root, {cwd})`; write the receipt-bearing evidence in one step under `withChecklistLock`)
- Test: covered by CHK-004 smoke

**Verify**:
- `node bin/lattice.js verification_run --help` shows the command
- Running it against an intent with a pinned command writes a `mechanical:true` receipt (exit 0 + selectorMatched); `node bin/lattice.js validate --story=B-1507 --json` shows the row covered

**DoneWhen**:
- `verification_run --intentRef=CHK-nnn:lane:i` resolves the pin, executes it via the shared helper, and atomically writes evidence with a real receipt; the caller never authors the command (it comes from the pin)
- An intent with no pinned command/selector is refused with a clear error and no covered row is minted
- Result is derived from the receipt (exit + selector), never from a caller-supplied `result`
- `verification_evidence_add` is left working (staged migration — NOT hard-broken)

---

## CHK-002: Make the stale-evidence refresh re-execute the pinned command and re-issue a real receipt

**Owner**: lattice-implementer
**DependsOn**: none (independent of CHK-001, but serialized — same file)
**Files**:
- Modify: packages/main/src/handlers/checklist.ts (`verification_evidence_refresh_stale`, ~:1452-1542; today it DEMOTES a mechanical receipt at :1500-1508). Re-read this function against current HEAD before editing — B-3b88 also edits it.
- Test: CHK-004 smoke

**Verify**:
- After material drift, `node bin/lattice.js verification_evidence_refresh_stale --storyId=...` re-runs the pinned command and the row stays `mechanical:true` bound to the new materialHash (not demoted) when it still passes
- If the pinned command fails or is unavailable on re-run, the row is left demoted/non-mechanical

**DoneWhen**:
- When a stale row has a pinned `verification:{command,selector}` for an executable intent, refresh RE-RUNS the command through the same `enforceAndStampEvidence` refusal path and re-stamps a fresh receipt bound to current material
- On any failure/unavailable command it leaves the row demoted/non-mechanical (no laundering back to covered)
- B-3b88's per-row self-contradiction guard still runs — the edit is additive; a smoke asserts both behaviors coexist
- Rows without a pin keep today's freshness-only refresh behavior

---

## CHK-003: Add a fail-open PreToolUse evidence-pin guard hook on both hosts

**Owner**: lattice-implementer
**DependsOn**: none (serialized — touches command-catalog.ts + cli-init.ts)
**Files**:
- Create: packages/main/src/core/evidence-pin-guard.ts (pure verdict logic: parse a `lattice verification_evidence_add|verification_run` command string, resolve the referenced intent's pin, return allow/deny + teaching reason on `--command`/`--selector` mismatch)
- Create: packages/main/src/handlers/evidence-pin-guard.ts (I/O shell mirroring prewrite-guard.ts:101; new command `verification_pin_guard_check {provider, toolName, toolInputJson|commandString, cwd, json}`)
- Modify: packages/main/src/cli/command-catalog.ts (register `verification_pin_guard_check`)
- Create: .claude/hooks/lattice-evidence-pretool.cjs (thin shim mirroring lattice-scope-pretool.cjs, but matching the **Bash** shell tool; forwards the command string; exit 2 deny / exit 0 allow; fail-open)
- Create: .codex/hooks/lattice-evidence-pretool.cjs + Modify .codex/hooks.json (add a PreToolUse matcher for Codex's **real emitted shell-tool name** — NOT apply_patch|Edit|Write, which the INIT reviewer confirmed does not match shell)
- Modify: packages/main/src/cli-init.ts (emit the two new hook shims via a render fn, mirror :1046)
- Test: CHK-004 e2e

**Verify**:
- Claude shim: a `verification_evidence_add` with a `--command`/`--selector` mismatching the pin exits 2 with a teaching message; a matching one exits 0
- Any hook error (missing CLI, parse fail, timeout, no active story) exits 0 (fail-open)
- Codex e2e: a synthesized PreToolUse payload with Codex's real shell tool_name triggers the verdict

**DoneWhen**:
- The `verification_pin_guard_check` command returns a deny verdict for a mismatched evidence-write command and allow otherwise
- Both host shims are wired and fail-open; the handler still refuses the same mismatch when the hook is bypassed (hook is non-load-bearing — asserted in the smoke)
- The Codex hook matches the real emitted shell-tool name, proven by an e2e; if the token cannot be confirmed in this environment, the Codex matcher uses the documented candidate and the e2e is marked explicitly pending (never a false green), while the Claude side ships fully

---

## CHK-004: Add a RED-first smoke covering verification_run, refresh re-execution, and the guard verdict; register it in validate

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Create: packages/main/src/tasks/verification-run-and-guard-smoke.ts
- Modify: lattice.config.json (validate.commands), package.json + packages/main/package.json (script wiring)
- Test: this IS the test

**Verify**:
- `node packages/main/dist/tasks/verification-run-and-guard-smoke.js` prints `verification-run-and-guard-smoke: PASS`, exit 0
- `node bin/lattice.js validate --story=B-1507 --json` includes the smoke and is green

**DoneWhen**:
- RED-first: each assertion mutation-kills (reverting verification_run execution, the refresh re-execution, or the guard verdict makes the smoke fail)
- Drives all three behaviors through their real CLI/handler entry points (not reimplemented logic), including the fail-open path and the handler-refuses-when-hook-bypassed adversarial case
- Registered in lattice.config.json validate.commands and package.json
