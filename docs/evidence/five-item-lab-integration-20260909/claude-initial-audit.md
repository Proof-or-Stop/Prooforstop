# Independent Claude CLI integration audit — five-item maintenance repair

**Candidate:** `3b55ae70ddda3f6085ec0b0473847da2cacfef9c`
**Against current main:** `04e66fdbaeaeeb540a80c9f8e16085a5ee468f5a` (0.3.285)
**Historical candidate integrated:** `50ca0454dc8d6e2f44aa34918493da7415ee2c78` from base `cf21df09c273074d7aa3227a5f436c6f5badf47a`
**Runtime:** private frozen checkout `/var/folders/.../pos-frozen-integration-audit-lm4icvth/repo`, Node v26.8.1, TypeScript 5.9.3, darwin 25.6.0
**Date:** 2026-09-09
**Role:** independent auditor. No source edits, no commits, no Story lifecycle invocation, no approvals on behalf of the user. Worktree verified clean and HEAD unchanged at end of audit.

---

## Verdict

**PASS WITH FINDINGS.**

All twenty-two checks in the integration contract (`experiments/five-item-integration/checks.json`) pass individually in my independent runtime. The five mechanisms are sound within the scopes stated below. The integration's hardest cross-parent requirements — retaining main's modular quorum coordinator and its exact `jobs=2`/shared-Git declaration, migrating 135 command identities without renumbering, and making every declared command conflict with the local build via the effective barrier — are correct and independently reproduced.

Three findings remain. One (**F-1**) is a candidate-authored cross-parent provenance error in a pinned assertion, and is the one item I would want addressed before this is treated as settled. The other two are a wiring/coverage gap and an inherited main defect that the candidate did not introduce.

No finding contradicts the five-item repair claims themselves. I did **not** verify, and do **not** assert, any universal 48% speedup, identical reviewer recall, or that all foreign owner sessions are pinned.

---

## Findings

### F-1 — MEDIUM — `commandSetDigest` re-pinned to the historical 134-command value

**Location:** `packages/main/src/tasks/validation-tier-planner-smoke.ts:503-504`

```
// The Lab-maintenance registration adds the 134th command; all prior commands remain.
// Lab opt-in adds only --jobs=4 for the complete73 quorum suite and --probe-jobs=4 ...
assert.equal(real.commandSetDigest, 'b29365c6a2ba5e50d50e05fd12654e505922413117531f37ce76e7716d859653', ...);
```

**Reproduction:** `node packages/main/dist/tasks/validation-tier-planner-smoke.js` → exit 1, `FAIL F-023`
(`evidence/p17-validation-tier-planner.log`); origin traced by `evidence/probes/p18-commandset-digest-origin.mjs` (`evidence/p18-commandset-digest-origin.log`):

| config | commands | `commandSetDigest` |
|---|---|---|
| base `cf21df09` | 134 | `b5e05c15…` |
| **historical `50ca0454`** | **134** | **`b29365c6…`** ← the value pinned by the candidate |
| main `04e66fdb` | 135 | `fdcf2fa5…` |
| **candidate `3b55ae70`** | **135** | **`63f92341…`** ← the correct value |

The pinned digest is **byte-identical to the historical 134-command config's digest**, not the integrated 135-command config's. The accompanying comment compounds this: it claims "adds the 134th command" and "`--jobs=4` for the complete73 quorum suite", while the integrated config has 135 commands and deliberately uses `--jobs=2` for the quorum suite. Both statements describe the historical parent, not the integrated result.

This directly violates `experiments/five-item-integration/README.md:19` — *"Do not represent historical 134-command results as current 135-command results."*

**Classification — partly inherited, partly candidate-introduced. Both proven:**
- *Inherited:* main's own pin `6f6a4fa0…` also does not match main's config digest `fdcf2fa5…`, so `F-023` was **already red on main**. This candidate did not turn a green assertion red.
- *Candidate-introduced:* the candidate **changed** this pin and set it to a cross-parent stale value rather than recomputing it. The confound that digest computation itself changed is excluded: `packages/main/src/core/validation-command-identity.ts` (which builds the inventory and digest) is **unchanged** between main and candidate, and the `handlers/verifier.ts` diff touches only an import, two catch-clause integrity rethrows and the `sharedExecution` condition — not `configuredValidationCommands`.

**Applicability:** `node packages/main/dist/tasks/validation-tier-planner-smoke.js` is a configured validation command, so this surfaces in full validation. It is *not* in `checks.json`, so the integration contract reports GREEN while this is red.

**Correct value, if the pin is refreshed:** `63f9234131b7473f03917a37de401db5dcfbab11a38e4b53a2d7c9fa961565d4`, and the comment needs to say 135 commands and `--jobs=2`. I have made no such edit.

---

### F-2 — MEDIUM — the graph missing-output control is sound but wired into nothing

**Location:** `experiments/five-item-proof/graph-missing-control.mjs`

`docs/validation-performance.md` states as an active policy claim: *"The isolated missing-output control also requires refusal before any listener."* The rewrite of `packages/graph/scripts/verify-missing-assets-fail.mjs` removed that file's inline scenario-2 refusal branch (the old `main` version, lines 1-244, asserted "refuse before binding a port and name the file"), relying on this isolated control instead.

The isolated control is **not referenced anywhere in the repository** — not in `checks.json`, not in `experiments/five-item-proof/verify.mjs`, not in any `package.json` script, not in the five-item-proof README. Verified by repository-wide search (zero hits outside the file itself).

**The control itself is correct.** Executed directly it passes and is *stricter* than what it replaced: it instruments `net.Server.prototype.listen` and asserts the log file never appears, so refusal-before-listen is proven mechanically rather than inferred.

```
node experiments/five-item-proof/graph-missing-control.mjs
→ exit 0, 2.05s, GRAPH_MISSING_ASSETS_REFUSED_BEFORE_LISTEN
```
(`evidence/p5-graph-missing-control-after-build.log`)

**First run failed; that failure is environmental, and I proved it rather than dismissing it.** Initial run: exit 1, `ENOENT … packages/graph/assets/app.html` at `graph-missing-control.mjs:16` (`evidence/p3-graph-missing-control.log`). Cause: `packages/graph/assets/` and `packages/graph/dist` did not exist in this frozen runtime — `assets/` is gitignored (`git check-ignore` → `packages/graph/.gitignore:11:assets/`) and the graph package had never been built here. After `npm --prefix packages/graph run build` (exit 0, 1.12s), the identical command passes. Not a candidate defect.

**Secondary point (LOW, same file):** unlike its sibling `verify-missing-assets-fail.mjs:11`, which guards with `assert.ok(existsSync(asset),'PRECONDITION_FAILED: build graph client first')`, this control has no precondition guard and crashes with a raw `ENOENT`. That conflicts with `experiments/five-item-integration/README.md:15` — *"A missing dependency is never accepted as the target RED."* As written it cannot distinguish an unbuilt workspace from a genuine refusal failure.

**Applicability:** the net effect is that the "never listen without a client" invariant is currently enforced by no automatically executed test. On main it was also effectively unenforced — the old scenario-2 branch was dead whenever recovery succeeded, which is the normal case — so this is not a regression in *actual* coverage. It is a documentation-vs-reality gap: the doc reads as though the control runs.

---

### F-3 — LOW (inherited, not candidate-introduced) — retired-authority vocabulary guard is red on main

**Reproduction:** `node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js` → exit 1, 54.57s, `retired authority vocabulary guard found 17 violation(s)` (`evidence/p14-retired-authority-guard.log`).

All 17 violations are in a single file, `packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts` (lines 1847-1849, 1916, 1925-1934, 2078-2080), using retired `authorityDone` / `fullAuthorityDone` / `productionDone` vocabulary.

**Inheritance proven** (`evidence/p15-inherited-guard-proof.log`):
1. The file does not exist at base `cf21df09`; it was introduced by **main's own** quorum modularization commit `e96b6284bd perf: converge quorum smoke execution in Lab`.
2. Its blob is identical on main and candidate: `30833cc49ee88adb16a3f8233f2132dd167f1d65`.
3. The candidate's diff to the guard touches the vocabulary scanner **zero** times (only fingerprint map entries, an `onlyFile` parameter plus counters on `assertLoaderArgumentProvenance`, and a new CLI flag block).
4. Neither version carries an exemption for that file.
5. The violating lines are present verbatim in main's blob.

The candidate authors were aware of this: `retired-authority-vocabulary-guard-smoke.ts:5914-5916` states the configured no-argument entry "still runs every original guard, **including unrelated baseline failures**", and its `LAB_GRAPH_LOADER_PROOF_GREEN` marker is deliberately distinct from the full guard's PASS marker. That focused path is honest and it passes: `--lab-graph-loader-proof` → exit 0, `{"filesChecked":1,"mutantsChecked":14}` (`evidence/p16-lab-graph-loader-proof.log`).

**Not a finding against this candidate.** Recorded so it is not misattributed, and because it means the full guard cannot currently certify the four fingerprints the candidate rotated in that file.

---

## What I verified affirmatively

### Retained main quorum sources and tests — correct

- `packages/main/tests/red/red-B-e40f-lab-convergence.mjs` is **unchanged** from main (empty diff over `packages/main/tests/red/`), and passes: exit 0, 2.38s. All 19 quorum source files under `packages/main/src` are unchanged. The B-e40f contracts were preserved, not rewritten.
- The quorum config row is **byte-identical to main's**: `--jobs=2`, `resources: [{git-common-dir, ".", shared}]`. The historical prototype's `--jobs=4` and its five-claim declaration (including the exclusive `validate-plan-barrier`) were **not** imported. Both `retainedMainConflicts` entries in `config-migration.json` are honored.
- **Independent cross-parent mutation probe** (`evidence/probes/p13-quorum-exact-guard-probe.mjs`, `evidence/p13-quorum-exact-guard-probe.log`) — I re-applied the old prototype through the real `configuredValidationCommands` / `resolveValidationPlanEntries` path and the exact guard at `validate-resource-claims.test.mjs:265-275`:

| mutation | result |
|---|---|
| control (unmutated candidate) | GUARD-PASSES |
| import historical 5-claim declaration | GUARD-REJECTS |
| revert `--jobs=2` → `--jobs=4` | GUARD-REJECTS |
| upgrade raw git claim to `exclusive` | GUARD-REJECTS |
| append an extra `fixed-path` claim | GUARD-REJECTS |

*Correction to my own intermediate result:* an earlier probe of mine reported these mutations as uncaught. That probe targeted `verifyResourceAudit`, which by design scopes only the 20 retained reviews and deliberately does not police the superseded quorum row. Pointed at the actual guard, all four mutations are rejected. No finding.

### Command-identity config migration (135 rows) — correct

- 135 commands before and after; **no command added or removed**; all 135 identity keys unique on both sides (`executable + argv` minus `--jobs=` / `--probe-jobs=`).
- Main's 110 existing resource declarations are preserved **byte-identically**. The migration only *added* declarations to the 25 rows that had none (110 → 135). Nothing was overwritten.
- Exactly one argv difference vs main: `proofstory-acceptance-basis-smoke` gains `--probe-jobs=4`, matching the historical row. Under the declared `identityKey` this is the same command identity, so it is a correct identity-based migration rather than a renumbering. The source accepts it: `proofstory-acceptance-basis-smoke.ts:53-55` validates `/^--probe-jobs=[1-4]$/` and refuses otherwise.

### Effective barrier vs raw Git-only claims — the required condition holds

`evidence/probes/p1-effective-barrier-probe.mjs` → `evidence/p1-effective-barrier-probe.log`, using the real `resolveValidationPlanEntries` and `claimsConflict`:

- quorum raw declaration: `[{git-common-dir, ".", shared}]` (Git-only, no barrier)
- executor injects a **shared** plan barrier; local build declares an **exclusive** plan barrier on the same canonical key
- `claimsConflict(quorum, build)` = **true**, both directions
- **routine commands that do NOT conflict with the local build: 0 of 135**
- **DONE entries that do NOT conflict with the local build: 0 of 2**
- a synthetic new command declaring only a raw shared Git claim also conflicts: **true**

### Resource audit — every published number reproduces exactly

`evidence/probes/p2-audit-20-14-5-1.mjs` → `evidence/p2-audit-20-14-5-1.log`, computed independently from the real config and resolver:

- 27 audit entries: 20 `safe-to-declare-shared` + 7 `leave-undeclared`; the retired quorum review is held separately in `integration.supersededQuorumReview` (1 record), giving the documented 21 original shared-reader recommendations.
- The 20 resolve to **14** effective readers and **6** exclusive-barrier holders — matching the contract's pinned `{auditedReaders:20, effectivelySharedReaders:14, supersededReaders:6}`.
- Of those 6: 5 local writers plus `node scripts/verify-lab-worktree.mjs`, which is configured row 0 and carries an exclusive barrier — the build-order precheck. 14 + 5 + 1 = 20, exactly as `docs/validation-performance.md` claims.
- 11 routine commands hold an exclusive plan barrier = the 10 writers pinned verbatim at `capacity-config.mjs:21` plus the precheck, matching "Ten audited or conservatively retained routine writers … the initial precheck also holds an exclusive barrier".
- 26 of 27 entries bind to the current config by **exact argv**; the 1 non-match is `npm test`, correctly a `doneRequiredCommands` entry rather than a routine row. All 38 source paths referenced by the audit exist.

### Tests were not weakened to mask an incompatibility

I examined every diff that reduces assertion surface:

- **`validate-resource-claims.test.mjs`** — migrated, and net **stronger**. The old check permitted audited writers only by leaving them *undeclared*; the new one permits declaration but requires a resolved **exclusive** barrier. The `barriers`/`overlappable` split was correctly generalized from `exclusiveByDefault` to actual barrier presence, which keeps "no configured command may overlap an undeclared one" non-vacuous now that nothing is exclusive-by-default. A **new** per-writer negative-control loop (lines 343-347) substitutes `[REPO_READ]` for each audited writer and asserts the probe fires. *Consequence worth noting:* with `byDefault` now empty, the two fail-closed-default assertions over that set are vacuous against the real config; they remain exercised by the synthetic probes at lines 111-116.
- **`proofstory-acceptance-basis-smoke.ts`** — parallelized to `--probe-jobs`, and **stronger**: `assert.equal(probes.length,58)` pins coverage; each probe still runs both the CLI and direct-handler rejection plus the atomicity snapshot; a **new** `git rev-parse HEAD` check asserts rejected probes never commit shared state; `completedProbes` must deep-equal the full list, so nothing can be silently skipped; and `peakProbes<=probeJobs && (probeJobs===1||peakProbes>1)` proves the concurrency actually happened.
- **`verify-missing-assets-fail.mjs`** (266 deleted lines) — the recovery assertions are retained and tightened: it now asserts the **served bytes equal the recovered client bytes** (the old version accepted any body >1000 bytes with markup), checks served repository identity via `api/status`, runs recovery twice, refuses to overwrite an interrupted backup, and restores the exact original bytes. The removed scenario-2 branch is covered by F-2. Passes: exit 0, 6.61s, ports 50422/50425 (OS-assigned, not the old fixed 8819), worktree clean afterwards.
- **`verify-json-no-listener.mjs`** / **`verify-serves.mjs`** — pass, exit 0, OS-assigned port 50428.
- **`validation-protocol-smoke.ts`** — the two added `acquireOwnerLease` calls are fixture setup adapting to a genuine new requirement, not relaxed assertions.

The five-item contract's own guards are self-mutating and bite. `resource-audit-contract.mjs` carries six built-in negative controls, including the coordinated case at line 23-28 where **both** config and supersession metadata are edited together and `RESOURCE_AUDIT_WITHDRAWN_CLAIM` still fires, plus a positive control at line 30 proving an unrelated inserted row does not rebind an audited command (identity binding, not index binding). My independent probes confirmed `RESOURCE_AUDIT_DRIFT` on a silent writer-barrier downgrade and `AUDITED_COMMAND_DRIFT` on removing an audited command (`evidence/p12-crossparent-mutation-probe.log`).

### Sources referenced exist; no dead old-prototype dependencies

- All 22 `checks.json` paths exist; all 38 `resource-audit.json` source paths exist.
- No live references to the old prototype: `atomic-group` 0 hits, `13-case` 0, `quorum-atomic` 0. The 6 `jobs=4` hits are comments, benchmark documentation, the correctly-preserved historical `effectiveArgv` inside `resource-audit.json:1510`, and the legitimate `--probe-jobs=4`. No live quorum `--jobs=4`.
- Three apparent dead relative imports in `consumers.mjs` / `delivery.mjs` / `observe-consumers.mjs` are **false positives** of my scan: they are inside generated fixture file *contents* (e.g. `consumers.mjs:24` writes `src/add.mjs` before the fixture imports it), not static imports.

### Protected metadata and version not overwritten

`package.json` (0.3.285), `packages/main` (0.3.285), `packages/utils` (0.3.268), `packages/graph` (0.1.0), `packages/lab` (0.3.65) are all **unchanged**. No package-lock, CHANGELOG, version-manifest or `.proof-or-stop/` state file appears in the diff. Version rules remain the province of `finish --confirm`, which was not invoked.

### Process registry dependencies and fixtures

`verification_intent_recover` and `verification_intent_append` are registered coherently across all four surfaces: `command-catalog.ts` (schemas, with `reason: z.string().min(30)` and 64-hex digest constraints), `command-policy.ts` (`gateEvidence`, `storyScopedMutating`; append restricted to `['DEV']`, recover excluding terminal phases — matching the documented behavior), `process-fact-levels.ts`, and `process-fact-registry.ts` (required semantics + artifact rows). New `producerSourceRefs` all resolve to existing files. The `acceptance-basis` fixture additions register 25 structural closure paths, all of which exist.

*Minor asymmetry, no finding:* the local `requiredProcessFactSemantics` map in `scripts/verify-process-fact-contract.mjs:187` gained `verification_intent_append` but not `verification_intent_recover`. That map is iterated over its own entries (line 7148), so it is a spot-check list rather than an exhaustive one, and `recover` is covered by the authoritative `PROCESS_FACT_REQUIRED_SEMANTICS` in the registry.

### Rotated closeout-trust AST fingerprints — consistent, documented, lockstep

Four pins rotated in `retired-authority-vocabulary-guard-smoke.ts` (`delivery-context-pack.ts`, `cli-engine.ts`, `handlers/graph.ts` ×2 maps, `prompt-full-context-envelope-smoke.ts`), each mirrored in `verify-process-fact-contract.mjs`. Old values are fully removed from **both** files — no stale duplicates — satisfying the file's own lockstep convention. Three carry written re-approval rationales. All pinned-fingerprint assertions execute *before* the violation render at line 5634; the run reached that render, which means every rotated pin validated against current source.

`prompt-full-context-envelope-smoke.ts` is byte-identical across base, main, historical and candidate (blob `67cbeb6a94…`) yet its pin moved. Traced to `4588a43794 test: restore full validation fixture prerequisites and reviewed source pins`, which is an ancestor of the historical candidate `50ca0454` and not of main — i.e. a repair of a stale inherited pin, consistent with its commit message. No finding.

### Historical evidence archive — fully verified

`docs/evidence/five-item-lab-integration-20260909/historical-evidence.tar.gz`
SHA256 `8221371def0e3bd30cea8d0da0328ffba4a3fab3f223b023c3439ee2264ce307` — **matches** the stated digest.
2128 entries = 158 directories + 1970 regular files. The archive's own `SHA256SUMS` lists exactly **1969** payloads (the 1970th file being `SHA256SUMS` itself, which cannot list itself), reconciling the stated count. `shasum -a 256 -c SHA256SUMS` → **1969 OK, 0 FAILED** (`evidence/p11-archive-sha256sums-verify.log`). It contains the earlier Claude audit reports and is correctly labelled `"Historical evidence only; not new integration certification."`

---

## Five-item claims — supported scope

| # | Mechanism | Verdict | Scope actually supported by evidence |
|---|---|---|---|
| 1 | Identity / hash | **Supported** | `verify-hash-accuracy` 27/27 (exit 0, 7.85s); `bootstrap-identity` exit 0, 8.66s; implementation-pin mismatch refused before dispatch with `IMPLEMENTATION_PIN_MISMATCH`. Scope: **opt-in** host transport pin over loaded core + bootstrap + workspace extensions + dependency closure + Node. Does **not** establish that any other running owner or reviewer session is pinned, nor protect against a hostile host. |
| 2 | Bounded repair authority | **Supported** | `acceptance-revision` (5.07s), `signature-key-controls` (0.37s), `signature-batch-controls` (3.34s) all exit 0; `verification_intent_append` confined to DEV by `command-policy.ts`; append-only with signature chaining, no replacement or removal of original requirements. Scope: attributable repair provenance, **not** formal PASS evidence and not scope expansion. |
| 3 | Exact shared receipts with exclusions | **Supported** | `shared-config` (0.36s), `evidence-implementation` (9.58s), `complete-output-adversarial` (6.02s), `output-retention-contract` (0.41s), `exit-legacy-output` (0.40s) all exit 0. `validate.sharedExecution === true` enables sharing independently of dynamic mode (`verifier.ts:1554`), with `forbidden` / `never-reuse` / build-proof exclusions retained; both DONE commands remain non-reusable (0/2 eligible). Scope: **one** opted-in heavy command. **No** Story-wide or 48% speedup is claimed or verified here. |
| 4 | Heartbeat / publication / intent history recovery | **Supported** | `acceptance-checkpoint` (12.36s), `checkpoint-audit-controls` (13.07s), `checkpoint-owner-recovery` (20.58s), `publication-restart` (5.00s), `last-closure` (1.11s) all exit 0. Scope: local file loss and interrupted publication. The Git ref, object store and signing key remain the local trust root; destroying them is explicitly **outside** the recovery boundary, and no cross-clone trust transfer is claimed. |
| 5 | Resource capacity / build order | **Supported, and independently reproduced** | `resource-audit-contract` (0.24s), `capacity-config` (2.31s), `build-order` (4.72s), `validate-resource-claims` (2.55s) all exit 0; plus my own probes: 0/135 routine and 0/2 DONE commands fail to conflict with the local build; 20/14/6 audit resolution reproduced exactly; full-suite retains exclusive TCP 43127; graph checks use `GRAPH_VERIFY_PORT=0`. Scope: **declaration completeness and conflict correctness only** — not proof of command success or lower elapsed time. |

---

## Scope and limits of this audit

- Per instruction I did **not** run `full135`, `npm test`, or the 51-minute repetition. `FIVE_ITEM_INTEGRATION_GREEN` covers the 22 `checks.json` entries; it does **not** mean full validation is green — F-1 and F-3 are configured validation commands outside that set.
- I did not measure any performance figure. Every timing recorded is wall-clock cost of the check in my runtime, on an otherwise-loaded machine, and is not a benchmark.
- The graph package was built once in my private runtime to classify F-2. `packages/graph/assets/` and `dist/` are gitignored; no tracked file was modified and the worktree was verified clean.
- All 31 recorded command invocations with exit codes and measured times are in `evidence/run-summary.txt`; per-command output is in `evidence/*.log`; re-runnable probes are in `evidence/probes/`.

## Recommendation

The integration is sound and I recommend it can stand as local maintenance, with **F-1 addressed first** — it is a two-line correction (recompute the pin to `63f9234131b7473f03917a37de401db5dcfbab11a38e4b53a2d7c9fa961565d4` and fix the 134/`--jobs=4` comment to 135/`--jobs=2`), and leaving it in place would embed a historical-parent claim in a pinned assertion, which is precisely what the experiment README forbids. F-2 warrants either wiring `graph-missing-control.mjs` into `checks.json` or softening the documentation claim; it should also gain the precondition guard its sibling has. F-3 is main's to fix and should not block this candidate.

I have made no edits and given no approval on the user's behalf.
