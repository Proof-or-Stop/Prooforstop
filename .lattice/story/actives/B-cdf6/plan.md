# Plan: B-cdf6 Rename the lattice CLI brand to proof-or-stop: bin, active docs, and brand-pinned gates

Chosen option: **A — bin+docs rename, identifiers frozen.**

Governing rule (user decision 2026-08-11): *the rename affects current state and future work, not past
work or history.* Operationally — **if a surface records what already happened it is FROZEN; if it tells a
user what to run now or next it is RENAMED.**

Canonical forms (settled from `README.md:1` and `README.md:96`, which already declare this rename in progress):

| Context | Form |
|---|---|
| Prose / product name | `Proof-or-Stop` |
| Command / bin / identifier | `proof-or-stop` |
| Legacy to normalize | `Proofbound`, `Prooforstop`, `proof-stop`, `Proof-Or-Stop`, `proofstop`, `PROOFBOUND` |
| Distinct concept, PRESERVE verbatim | `ProofStory` (live code: `handlers/proofstory.ts`) |

Execution order is load-bearing: **CHK-001 → CHK-002 → CHK-003 → CHK-004 → CHK-005.** The mapping table
gates every replacement, the bin must exist before docs claim it, and CHK-005 closes the gates last.

---

## CHK-001: Establish the canonical brand token mapping and freeze the out-of-scope surfaces

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Create: `docs/requirements/decisions/brand-rename-mapping.md`

**Verify**:
- `test -f docs/requirements/decisions/brand-rename-mapping.md`
- Table contains a row for every distinct token shape, each with a RENAMED or FROZEN verdict
- Every FROZEN row carries a reason and a `user-visible in runtime output` value

**DoneWhen**:
- Mapping table enumerates: prose name, command name, the 13 salts, `.lattice/` state dir, the 13
  `lattice-`prefixed role IDs (of 17 total), npm package names, `lattice.config.json`, `LATTICE_*` env
  prefix, `<!-- lattice:start -->` markers, `lattice.remote-push-approval.v1`, the 391 story archives,
  and `CHANGELOG.md`
- `ProofStory` explicitly marked PRESERVE (distinct domain concept, not a brand variant)
- Explicit verdict recorded for `CHANGELOG.md` = **FROZEN** (records shipped releases → past record)
- **OQ-1 resolution action**: each of the 13 `lattice-`prefixed role IDs is recorded as
  **FROZEN-THIS-STORY** with the reason *"target canonical prefix is `proof-or-stop-*` per
  `proof-or-stop-agent-prompt-consolidation-execution-plan.md:36-43`; deferred here because renaming
  `subagent_type` values would break spawning for in-flight stories"* — so a future implementer reads the
  deferral as intentional and finds the owning plan, rather than concluding the freeze was an oversight
- `runtime-visible` column states what a user still sees after the rename (role IDs in `session_brief`,
  `.lattice/` paths in messages) so those read as intentional, not overlooked
- Rules on whether `LATTICE_PRODUCT_NAME` (currently the legacy `'Proofbound CLI'`) becomes `Proof-or-Stop`

---

## CHK-002: Rename the user-facing CLI invocation to proof-or-stop keeping lattice as a deprecated alias

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/package.json` (add `proof-or-stop` to `bin`, keep `lattice`)
- Create: `bin/proof-or-stop.js` (mirror of the 3-line `bin/lattice.js` wrapper)
- Modify: `packages/main/src/core/lattice-brand.ts` (flip `LATTICE_PRIMARY_BIN`; `LATTICE_PRODUCT_NAME` per CHK-001)
- Modify: `packages/main/src/cli/help-renderer.ts` (11 sites: consume `brand.invokedAs` for Usage lines)
- Modify: `packages/main/src/cli-engine.ts` (hardcoded `lattice <cmd>` hint + `lattice codex` error strings)
- Modify: `packages/main/src/handlers/session.ts:777` (`# lattice session brief` header)
- Modify: `packages/main/src/cli/alias-normalizer.ts:94` (accept BOTH tokens for the redundant-token tolerance)
- Test: `packages/main/src/tasks/rollout-check-smoke.ts:70`, `scripts/verify-entrypoints.mjs:277` and `:515`

> **Scope-contract path note**: declare the create-target as the directory `bin`, **not** `bin/proof-or-stop.js`.
> `core/scope-path-classifier.ts:141` has an `explicitRepoTopLevel` allowlist that omits `bin`, so a
> not-yet-existing `bin/<file>.js` resolves ambiguously against both repo-root and `packages/main/src/`
> and the contract init fails `BLOCKED: ambiguous scope path`. The directory form is unambiguous.

**Verify**:
- `npm --prefix packages/main run build` clean
- `node bin/proof-or-stop.js --version` prints the version
- `node bin/lattice.js --version` prints the SAME version (alias intact)
- `node bin/proof-or-stop.js help | grep -c "Usage: lattice"` returns 0
- `node bin/proof-or-stop.js session_brief | head -1` shows the new header
- `node scripts/verify-entrypoints.mjs` passes

**DoneWhen**:
- Both bin names resolve and print identical versions
- No help/usage line prints the old bin name when invoked as `proof-or-stop`
- `proof-or-stop proof-or-stop --version` is forgiven exactly as the `lattice lattice` form is
- `invokedAs` is actually consumed (not merely computed) so output mirrors how the CLI was invoked

---

## CHK-003: Replace lattice brand mentions in active docs per the approved mapping

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: `README.md` (incl. removing the now-satisfied rename-in-progress disclaimer at `:96`)
- Modify: `CLAUDE.md` (incl. the stale `16` thin-shim counts at `:791` and `:792` → 13-of-17)
- Modify: `AGENTS.md`, `docs/**` (~183 active files)
- Modify: `docs/requirements/decisions/lifecycle-artifact-scope.md:217` — **OQ-2 resolution action**: the
  sentence "`lattice` is the only active runtime/product command" is a stale pre-rename snapshot (that file
  contains zero `proof-or-stop` mentions). Update it to state `proof-or-stop` is primary with `lattice`
  retained as a deprecated alias, while **preserving** the paragraph's normative content about fresh-init
  managed-asset generation and legacy-path compatibility.
- Modify: `packages/main/templates/agents/*.md` (17 registry templates — **the only place role bodies are edited**)
- **MUST NOT touch**: `.lattice/story/**`, `CHANGELOG.md` (both path-blocked in execution-boundary)

> **HOST-NEUTRAL PROMPT INVARIANT — scope-check gap 1**
> (`docs/requirements/decisions/lifecycle-artifact-scope.md:244-258`, Policy B-097f)
>
> The package registry (`packages/main/templates/agents/*.md`) is the **single source** for role bodies.
> Each host keeps only a **body-free thin adapter**: `.claude/agents/*.md` is frontmatter + a CLI pointer;
> `.lattice-codex/lattice.json` is a manifest with `promptMode: 'registry'`.
>
> Therefore prose rewriting happens **in the registry templates only**. Host shims may be touched *solely*
> to update frontmatter `description` or the pointer command text, and **must not gain a prompt body** — a
> rebranded body copied into a host directory silently breaks the single-source invariant. Verify with:
> `grep -c . .claude/agents/<role>.md` stays at shim size (no body inlined).

**Verify**:
- `grep -rIl "lattice" README.md CLAUDE.md AGENTS.md docs packages/main/templates` — every remaining hit
  traces to a FROZEN row in the CHK-001 table
- `git diff --stat -- .lattice/story CHANGELOG.md` is EMPTY (proves the freeze held)
- No stray spelling survives: `grep -rIoE "Prooforstop|proof-stop|Proof-Or-Stop|proofstop|PROOFBOUND" docs *.md`
- `grep -rn "ProofStory" packages/main/src | wc -l` unchanged from baseline (preserved)
- **Host-neutral invariant holds**: `.claude/agents/*.md` and `.lattice-codex/` gain no prompt body —
  compare each shim's line count against its pre-change baseline; any growth beyond frontmatter is a fail
- `grep -n "only active runtime/product command" docs/requirements/decisions/lifecycle-artifact-scope.md`
  no longer asserts `lattice` as the sole command (OQ-2 action applied)

**DoneWhen**:
- Command examples in active docs read `proof-or-stop <cmd>`
- Prose product name reads `Proof-or-Stop`; legacy `Proofbound` normalized
- Frozen identifiers appear verbatim, and where a doc explains one it says why it stays
- Stray spellings normalized rather than a new variant added
- `.lattice/story/**` and `CHANGELOG.md` untouched

---

## CHK-004: Add a brand-consistency acceptance gate and reconcile the existing residue guard

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-003
**Files**:
- Modify: `scripts/verify-lattice-residue.mjs` (**KEEP the filename** — 6+ live couplings)
- Modify: `CLAUDE.md` gate-table row at `:835` if the gate's stated meaning changes

**Verify**:
- `node scripts/verify-lattice-residue.mjs --self-test` passes
- `node scripts/verify-lattice-residue.mjs` passes
- `npm run test:lattice-residue` passes
- `node scripts/verify-residue-inject-repro.mjs` still proves the gate catches an injected hit
- Negative test: an intentional un-renamed prose mention in an active doc is DETECTED

**DoneWhen**:
- The self-test no longer asserts a claim contradicting the rename (it currently asserts
  `lattice-review-integrity-v1` is CLEAN)
- Gate scope is prose/active-docs or exemption-based — **NOT** allowlist-free over `packages/*/src`,
  because 605 files there legitimately contain the token
- Filename unchanged, so `review-preflight.ts:91` (fails closed) and `package.json:19` keep resolving
- `CLAUDE.md:835` accurately describes what the gate now enforces

---

## CHK-005: Reconcile all brand-pinned mechanical gates and bump the CLI version

**Owner**: lattice-implementer
**DependsOn**: CHK-002, CHK-003, CHK-004
**Files**:
- Modify: `scripts/verify-process-fact-contract.mjs` (literal command strings, incl. `:583`, `:586`, `:1333`)
- Modify: `scripts/verify-proof-or-stop-prompt-baseline.mjs` (re-approve per-role `templateHash`)
- Modify: `docs/requirements/baselines/proof-or-stop-prompt-baseline.json` (regenerate)
- Modify: `packages/main/src/core/audit-scan.ts:100` (extractor learns BOTH bin tokens)
- Modify: `packages/main/package.json`, `package.json`, `package-lock.json`,
  `packages/main/src/core/lattice-brand.ts:3` (`0.3.251` → `0.3.252`)
- Test: new regression test for the audit-scan extractor

**Verify**:
- `npm test` green end to end (the DONE-blocking suite)
- `npm run test:process-fact-contract` passes
- `npm run test:proof-or-stop-prompt-baseline` passes
- **Negative regression**: a doc line referencing `proof-or-stop no_such_command` REPORTS drift
  (proves the extractor did not go vacuously blind)
- `node bin/proof-or-stop.js --version` prints `0.3.252`

**DoneWhen**:
- Root `npm test` passes, so the DONE gate is reachable
- `scanCommandDrift` detects a bogus command under BOTH bin tokens, with a test proving it
- An empty extraction can never be mistaken for a clean scan
- CLI patch version bumped and rebuilt per CLAUDE.md version discipline

---

## Dependency graph (acyclic)

```
CHK-001 (mapping table, gates everything)
   ├─→ CHK-002 (bin + CLI output)
   │      └─→ CHK-003 (active docs)
   │             ├─→ CHK-004 (brand gate)
   │             └─→ CHK-005 (pinned gates + version bump)  ← also DependsOn CHK-002, CHK-004
```

No cycles. **Fully serial** — every item shares files with its predecessor
(`CLAUDE.md` in 003/004, `lattice-brand.ts` in 002/005, `package.json` in 002/005), so the
non-overlapping-write-set condition for parallel dispatch is not met.

## CHK-006: Complete the rename under the past-evidence-only freeze criterion

**Owner**: lattice-implementer (split into two passes — see below)
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005

Added mid-DEV after two user corrections. The CHK-001 table over-froze by conflating **coupling**
with **evidence**; and the repo is **multi-developer**, so every rename must be additive at any
boundary a teammate's merged code can touch. See the mapping table's "Governing rule" section —
it now carries both corrections.

**The only true past-evidence tokens: the 13 salt string literals.** Everything else is coupling.

### Pass A — filenames, entrypoints, packaging, generated assets

**Files**:
- Modify: `packages/main/src/init-assets.ts` (**31 stale invocations — highest impact: this is what
  `init` writes into NEW user projects**)
- Create: `bin/proof-or-stop-codex.js`; keep `bin/lattice.js` + `bin/lattice-codex.js` as aliases
- Modify: root `package.json`, `packages/main/package.json` (add new name, keep old resolving)
- Modify: `.githooks/pre-push` — **must accept both package names in the same commit**, else the
  recursive-tsc gate silently self-disarms
- Modify: `.codex/` (17 tokens, never scanned), `docs/CLI.md` (16 + 13 bin citations)

### Pass B — env vars, code identifiers, config/state paths

**Files**:
- Modify: `LATTICE_*` → `PROOF_OR_STOP_*` across 245 files (146 distinct names), with a
  **read-both** resolver preferring the new name
- Modify: exported identifiers (`runLattice` 129, `LatticeConfig` 44, `writeLatticeConfig` 39, …)
  — **re-export every old symbol name as a deprecated alias**
- Modify: `.lattice/` / `lattice.config.json` / `.lattice-serve.json` readers → read both, write new

### Verify (both passes)

- `npm test` green (DONE-blocking suite)
- Old-name compat proven: a fixture using `LATTICE_*` exports, a `.lattice/` dir, `lattice.config.json`,
  `node bin/lattice.js` and `import { runLattice } from '@lattice/core'` all still work
- `.githooks/pre-push` still arms (assert it does NOT `exit 0` on this repo)
- Fresh-init output contains no `bin/lattice.js`
- Gate roots widened to `packages/*/src` prose, `scripts/`, `bin/`, `.codex/`, repo-root files —
  and the widened gate PASSES
- The 13 salt literals byte-unchanged; the 12 stored `_hash` files still verify

**DoneWhen**: current + future state reads `proof-or-stop`; `lattice` survives only as frozen salt
literals and labelled compatibility aliases; a teammate's pre-rename branch still builds after merge.

## Scope-check dispositions (PLAN reviewer, 34 features / 24 covered / 8 excluded)

| Item | Disposition |
|---|---|
| **Gap 1** — host-neutral prompt content invariant (`lifecycle-artifact-scope.md:244-258`) | **Folded into CHK-003**: prose edits confined to the 17 registry templates; host shims stay body-free, with a verify step comparing shim line counts to baseline |
| **Gap 2** — managed-block marker migration precedent (`legacy-to-lattice-role-naming-execution-plan.md`) | **No action**: reviewer rated it informational. B-cdf6 introduces no new marker form, and `<!-- lattice:start -->` is FROZEN per CHK-001, so the precedent is not engaged |
| **OQ-1** — role-ID prefix conflict | **Resolved**: complementary scopes, not a contradiction. Freeze recorded as FROZEN-THIS-STORY in CHK-001 pointing at the owning plan |
| **OQ-2** — `lattice` as "only active runtime command" | **Resolved**: stale pre-rename snapshot (zero `proof-or-stop` mentions in that file). CHK-003 updates the sentence while preserving its normative fresh-init content |

## Risk register (from decision_set preMortem)

| Risk | Mitigation owner |
|---|---|
| docs-drift goes vacuously blind | CHK-005 negative regression test |
| `npm test` fails at the DONE gate | CHK-005 sequenced last, run locally before REVIEW |
| Bulk replace hits a salt or package name | CHK-001 table approved first; path-level block already active |
| CLI still prints the old brand to users | CHK-002 covers output strings + pinned assertions |
