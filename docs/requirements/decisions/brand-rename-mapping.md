# Brand rename mapping: `lattice` → `proof-or-stop` (B-cdf6)

**Status**: approved mapping for B-cdf6. This table **gates every replacement** performed in
CHK-002 through CHK-005. A token shape that is not listed here has no approved verdict and must
not be rewritten; add a row first.

## Governing rule

**⚠ SUPERSEDED — read this section before trusting any verdict below.**

The verdicts in the table below were assigned under an earlier, **too-permissive** reading of the
freeze test. The user corrected it on 2026-08-11 (verbatim, translated):

> "Any `lattice` that has **no effect on the past evidence chain** must be refactored, including
> filenames, documentation, and code; any `lattice` that **does affect the past evidence chain**
> gets compatibility handling — do not change or affect the past, but do not let it affect the
> future either. After the story completes, `lattice` is frozen into the past; current state and
> future are `proof-or-stop`."

### The corrected test

For each token, ask **only** this: *is this string read back in order to verify past evidence?*

- **YES → FROZEN + COMPAT.** Keep the literal so already-persisted evidence still verifies, and
  add a compatibility path so it does not propagate forward. New writes use the new name.
- **NO → RENAMED.** Coupling is not evidence. Filenames, env-var names, package names, code
  identifiers and state-directory names are all coupling: renaming them merely requires editing
  every reader in the same commit, which is work, not a reason to freeze.

### What actually qualifies as past evidence

Audited: **only the 13 salt string literals**. They are hashed into `_hash` fields on already-
persisted artifacts (12 such files exist under `.lattice/story/actives/B-cdf6/` alone), so
renaming a salt silently invalidates signatures that were computed with the old value.

### Where the original table was wrong

It conflated **coupling** with **evidence** and therefore froze too much. The following were
marked FROZEN purely because renaming them requires coordinated edits — they carry no stored
signature and are **RENAMED** under the corrected test:

| Wrongly frozen | Why it is only coupling |
|---|---|
| `LATTICE_*` env-var names (146 across 245 files) | Read at runtime; nothing hashes them. Compatibility is explicit per variable, not universal: the active validation-shard runtime is canonical-only and reads `PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER`; it does not read or accept `LATTICE_VALIDATION_SHARD_ADAPTER`. |
| `bin/lattice.js`, `bin/lattice-codex.js` filenames | Never in the table at all — an outright omission. `init-assets.ts` emits 31 stale invocations into **new user projects**. |
| npm names `lattice`, `@lattice/core` | `.githooks/pre-push:148` arms on the exact string, so it must be updated in the same commit or the gate **silently self-disarms**. That is a sequencing hazard, not evidence. |
| `.lattice/` state dir, `.lattice-serve.json`, `.lattice-codex/`, `lattice.config.json` | Path names. Need read-both compat so existing installs resolve; new writes use the new name. |
| Code identifiers (`runLattice` 129, `LatticeConfig` 44, …) | Pure internal symbols. |

`PRESERVE` remains correct for `ProofStory` (a distinct domain concept, not a brand variant).

`FROZEN-THIS-STORY` remains correct **only** for the agent role IDs, whose migration is owned by
`proof-or-stop-agent-prompt-consolidation-execution-plan.md` — renaming `subagent_type` values
mid-flight breaks spawning for in-flight stories.

### Additional hard constraint: this repository is multi-developer

User constraint, 2026-08-11: *"this repository is developed by multiple people; you need to
guarantee that other people's code still works normally after it is merged in."*

Verified empirically: two distinct authors over the last 60 commits (Harmonygo 58, Pan Qi 2), and
local `main` is 2 commits ahead of `origin/main`. Teammate branches authored against the
`lattice`-era names **will** merge into this rename.

This makes every rename **additive at any boundary another developer's code can touch**. A
compatibility shim here is not a temporary migration aid for old on-disk state — it is a **durable
bilingual contract** for code that does not exist in this repo yet:

| Boundary | Required behaviour |
|---|---|
| npm package name | Keep `lattice` / `@lattice/core` resolving; add the new name. **Never remove.** 14 files import `@lattice/core` today. |
| `bin/` entries | **SUPERSEDED by B-cc10 CHK-006 (2026-08-17): `bin/lattice.js` and `bin/lattice-codex.js` are REMOVED, not retained.** The operator explicitly instructed removal, which overrides the retention argued below; the break is announced in `CHANGELOG.md` and the replacements are `bin/proof-or-stop.js` / `bin/proof-or-stop-codex.js`. The original reasoning is kept verbatim below because it documents *why* retention was once correct and what constraint the removal knowingly gives up. — `bin/lattice.js` keeps working; `bin/proof-or-stop.js` is canonical. **Retention reason CORRECTED (2026-08-12):** the original rationale was "32 in-flight stories invoke it", i.e. *past references* — that was wrong. Those references are plain text in story artifacts; they carry no signature and nothing verifies against them, so by the past-evidence test they would NOT justify a freeze. The actual reason is the **multi-developer constraint**: a teammate branch authored before the rename may `node bin/lattice.js`, and deleting the wrapper would break their code on merge. Keeping the *file* is required; **documenting** it in a current-facing reference is not, so the `docs/CLI.md` alias section was reduced to a one-line pointer. |
| Exported code identifiers | If renamed, **re-export the old symbol as a deprecated alias**, so a teammate's `import { runLattice } from '@lattice/core'` still resolves. A silent build break on merge is the worst outcome: it surfaces as *their* bug in *their* branch. |
| `LATTICE_*` env vars | Read **both** names, preferring the new one. Never *require* the new name. |
| `.lattice/` paths, `lattice.config.json` | Read both; write the new form. Existing installs must keep resolving. |

⚠ **Sequencing hazard**: `.githooks/pre-push:148` arms the recursive-tsc defense by comparing
`PKG_NAME` to the exact string `@lattice/core`, and `exit 0`s on mismatch. Renaming the package
without updating that line **in the same commit** does not fail loudly — it silently disarms the
gate.

**CHK-006 re-executes the rename under this corrected test.** Until it lands, treat a `FROZEN`
verdict below as "not yet re-audited" rather than "confirmed frozen".

## Canonical forms

Settled from `README.md:1` (`# Proof-or-Stop`) and `README.md:96`, which already declares this
rename as in progress.

| Context | Canonical form |
|---|---|
| Prose / product name | `Proof-or-Stop` |
| Command / bin / identifier | `proof-or-stop` |
| Legacy spellings to normalize | `Proofbound`, `Prooforstop`, `proof-stop`, `Proof-Or-Stop`, `proofstop`, `PROOFBOUND` |
| Distinct concept — preserve verbatim | `ProofStory` |

Verified stray-spelling census at time of writing (`grep -rIoE` across the repo, excluding
`.git` and `node_modules`): `PROOFBOUND` 25, `proof-stop` 17, `Prooforstop` 16, `Proof-Or-Stop`
14, `proofstop` 10. These are normalized to the canonical form **only inside active docs**
(CHK-003); occurrences inside FROZEN surfaces stay as they are.

## Why the "User-visible in runtime output" column exists

After this story ships, a user running `proof-or-stop session_brief` will **still** see
`lattice-*` role IDs and `.lattice/` paths in the output. That is intentional, not an oversight.
The last column records exactly what residue each frozen row leaves in front of a user, so that
a future reader (or reviewer) can tell a deliberate freeze apart from a missed replacement.

---

## Mapping table

| Token shape | Verdict | Replacement (if renamed) | Reason | User-visible in runtime output |
|---|---|---|---|---|
| Prose product name in active docs (`Lattice`, `Proofbound`, and the stray spellings above) | RENAMED | `Proof-or-Stop` | Active docs tell a reader what the product *is* now. `README.md:1` already declares `# Proof-or-Stop`. | Yes — README, CLAUDE.md, `docs/**` prose read `Proof-or-Stop`. |
| CLI bin name / invocation in active docs (`lattice <cmd>`) | RENAMED | `proof-or-stop <cmd>` | Tells a user what to run *now*. This is the core of the user's request. | Yes — every documented command example. |
| `bin/` wrapper entry + `packages/main/package.json` `bin` map | RENAMED (additive) | add `proof-or-stop`; **keep** `lattice` as a deprecated alias | The alias is the load-bearing safety property: it makes the change additive at the CLI boundary, so in-flight stories and the pre-push hook keep working. Verified today `bin` is `{"lattice": "dist/cli.js"}` and `bin/` holds `lattice.js`, `lattice-codex.js`, `bootstrap-runner.js`. **UPDATE (B-cc10 CHK-006): the `package.json` bin-map `lattice` alias is UNCHANGED and still retained, but the two `bin/*.js` alias FILES were deleted; `bin/` now holds `proof-or-stop.js`, `proof-or-stop-codex.js`, `bootstrap-runner.js`.** | Yes — both `proof-or-stop --version` and `lattice --version` resolve. |
| `LATTICE_PRIMARY_BIN` (`packages/main/src/core/lattice-brand.ts:5`, currently `'lattice'`) | RENAMED | `'proof-or-stop'`, with help/usage lines consuming `brand.invokedAs` | `help-renderer.ts` derives 11 `Usage:` lines from this constant (`:182`, `:210`, `:236-241`, `:304-305`), so `proof-or-stop help` would otherwise print `Usage: lattice ...` — the CLI would teach the old brand. | Yes — all `Usage:` / `Entrypoint:` lines. |
| `LATTICE_PRODUCT_NAME` (`packages/main/src/core/lattice-brand.ts:4`, currently `'Proofbound CLI'`) | **RENAMED** | `'Proof-or-Stop'` | **Ruling for CHK-001.** `lattice --version` prints `Proofbound CLI 0.3.251` today (verified). `Proofbound` is a legacy spelling on the normalize list, not an approved prose form, and `README.md:96` explicitly flags it as a rename in progress. `--version` states what the product *is now*, so it is RENAMED. | Yes — `proof-or-stop --version` prints `Proof-or-Stop <version>`. |
| Literal `# lattice session brief` header (`packages/main/src/handlers/session.ts:777`) | RENAMED | `# proof-or-stop session brief` | The most-seen string in the product, given CLAUDE.md rule 0. Tells the user which tool they are in. Pinned by `scripts/verify-entrypoints.mjs:277` and `:515`, which must be updated in the same commit. | Yes — first line of every `session_brief`. |
| Hardcoded `lattice <cmd>` hints and error strings in `cli-engine.ts` | RENAMED | `proof-or-stop <cmd>` (mirroring `invokedAs`) | Next-action guidance, i.e. what to run next. | Yes — error and hint text. |
| Help / usage output strings generally | RENAMED | derived from `brand.invokedAs` | Output should mirror how the CLI was actually invoked. | Yes. |
| **The 13 signature salt literals** (see enumeration below) | **FROZEN** | — | Each salt is hashed into `_hash` fields **already persisted** on live artifacts. Renaming a salt silently invalidates every stored signature, so active stories would immediately read as tampered and gate-block. These record what already happened. | Indirect — appears in no normal output, but a corrupted signature would surface as `*_tampered` gate blockers. |
| `.lattice/` state directory (the NAME; its VALUE `.lattice` is frozen) | **RENAMED (additive)** | — | Live on-disk state (locks, `activity.jsonl`, `authority.md`, `learning/`, `evidence/`, `dev-memory/`). Renaming it in docs only makes docs wrong; renaming in code orphans existing state. It stores what already happened. | **Yes** — paths like `.lattice/story/actives/B-xxxx/` appear in `session_brief`, gate diagnostics and error messages. Intentional. |
| `.lattice-serve.json` (the NAME; its VALUE is frozen) | **RENAMED (additive)** | — | Runtime discovery file written by `serve` and read back by tooling; renaming breaks the read side. (Runtime-generated; gitignored, absent from a clean tree.) | Yes — referenced in debugging docs and by `serve` output. |
| `.lattice-codex/` (incl. `.lattice-codex/lattice.json` manifest) | FROZEN | — | Live Codex adapter state directory + manifest path; the adapter resolves it by exact name. | Yes — in Codex adapter paths and `verify_codex` output. |
| **The 13 `lattice-`prefixed agent role IDs** (of 17 total registry templates; see enumeration below) | **FROZEN-THIS-STORY** | *(target: `proof-or-stop-*`)* | The target canonical prefix is `proof-or-stop-*` per `docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md:36-43`, which states all canonical role IDs use the `proof-or-stop-*` prefix and that current `lattice-*` names are "transitional aliases only". Renaming is **deferred here** because these are `subagent_type` values resolved against host shims plus the registry manifest — changing them would break spawning for in-flight stories. **This freeze is intentional and owned by that plan, not an oversight.** | **Yes** — `proof-or-stop reviewer_list` and `session_brief` still print `lattice-review-concept`, `lattice-implementer`, etc. Intentional; see the owning plan. |
| The 4 non-`lattice-` role IDs (`implementation-reviewer`, `product-reviewer`, `test-case-reviewer`, `test-intent`) | FROZEN-THIS-STORY | *(target: `proof-or-stop-*`)* | Same owning plan (`:36-43`) lists these as transitional aliases too. Not brand-token hits, but recorded so the 17-role set is completely accounted for. | Yes — same surfaces as above. |
| **390 frozen story archives** under `.lattice/story/` (markdown containing the brand token) | **FROZEN** | — | CLAUDE.md rule 8 forbids direct writes under the story directory; all story mutation goes through the CLI. These are historical records — rewriting them falsifies the audit trail. | Yes — quoted back in `story_get` / `session_brief` output. |
| `packages/main` npm package name `@lattice/core` | **FROZEN** | — | `.githooks/pre-push:148` gates the entire recursive-tsc pre-push defence on `PKG_NAME = "@lattice/core"` and **`exit 0`s on mismatch** (verified). Renaming the package therefore **silently self-disarms** the hook rather than failing loudly — the worst possible failure mode. | No — but a silent rename would remove a safety gate with no visible signal. |
| Root npm package name `lattice` | FROZEN | — | Package identity / lockfile key; renaming is a publish-level change outside this story's additive-at-the-CLI-boundary scope. | No. |
| `lattice.config.json` (the NAME; its VALUE is frozen) | **RENAMED (additive)** | — | The only config filename ever loaded (`init-assets.ts:599`, `:743`; `dashboard.ts:280-281` calls it canonical). Renaming orphans every existing project's config. | Yes — named in `proof-or-stop init` output as the canonical project config. |
| `LATTICE_*` environment-variable prefix (56 distinct vars verified under `packages/*/src`) | **RENAMED (additive)** | — | Env vars are an external contract with CI, shells and operator scripts. Renaming breaks every existing invocation with no deprecation path in this story. | Yes — documented in CLAUDE.md (e.g. `LATTICE_SESSION_BRIEF_FRESH_MINUTES`, `LATTICE_BRIEF_OUTPUT`). |
| `<!-- lattice:start -->` / `<!-- lattice:end -->` managed-block markers | FROZEN | — | Delimiters used to locate and rewrite managed blocks in already-installed files (`init-assets.ts:22`, `:40`; `claude-md-sync.ts:88`). Changing the marker orphans every existing managed block. B-cdf6 introduces no new marker form. | Yes — visible verbatim in `CLAUDE.md` / `AGENTS.md` managed regions. |
| `lattice.remote-push-approval.v1` schema literal | FROZEN | — | Exact-match schema string compared on both sides: `core/release-push-approval.ts:4` writes it, `.githooks/pre-push:78` rejects any approval whose `schema` differs. A one-sided rename breaks release approval. | Indirect — a mismatch surfaces as a refused push. |
| `CHANGELOG.md` (111 brand-token hits verified) | **FROZEN** | — | **Explicit verdict, previously unclassified.** It records shipped releases — a past record by definition. Rewriting historical release notes would falsify release history. It is neither in CHK-003's active-doc list nor implicitly frozen by path, so it is named here and path-blocked in execution: `git diff --stat -- CHANGELOG.md` must be empty. | No — not printed by the CLI. |
| `scripts/verify-lattice-residue.mjs` (filename) | FROZEN | — | Six-plus live couplings; `packages/main/src/handlers/review-preflight.ts:91` hardcodes the path and **fails closed** when absent. The script's *content* is reconciled in CHK-004; its *name* stays. | Yes — named in preflight gate output. |
| GitHub repo slug `Proof-or-Stop/Prooforstop` (README:5, :106, :140) | **FROZEN** | — | **External identifier, NOT a stray spelling.** Verified against the live remote: `git remote -v` → `git@github-pagepeek:Proof-or-Stop/Prooforstop.git`. The `Prooforstop` segment is the real repository name, so "normalizing" it would produce dead clone URLs and broken badge links. Distinguish from the `Prooforstop` *prose* misspelling, which IS normalized. | Yes — appears in clone/badge URLs users copy. |
| BibTeX citation key `huang2026proofstop` (README:125) | **FROZEN** | — | **Published bibliographic identifier.** A citation key is a stable external handle that third parties may already reference; rewriting it breaks existing bibliographies. Distinguish from the `proofstop` *prose* misspelling, which IS normalized. | Yes — user-copyable citation block. |
| `ProofStory` (695 occurrences under `packages/main/src`, incl. `handlers/proofstory.ts`) | **PRESERVE** | — | A distinct domain concept (`proofStory.*` config keys, acceptance topology / rollout gates), **not** a brand variant. Must survive the rename byte-for-byte; a case-insensitive sweep for `proof` would corrupt it. | Yes — `proofStory.acceptanceTopologyGateMode` etc. in gate diagnostics. |

---

## Enumerated freeze lists

### The 13 signature salt literals

Verified by `grep -rhoE "'lattice-[a-z0-9-]*-v[0-9]+'" packages/*/src | sort -u` — exactly 13,
matching the background's enumeration:

1. `lattice-review-integrity-v1`
2. `lattice-init-check-integrity-v1`
3. `lattice-delivery-check-integrity-v1`
4. `lattice-draft-check-integrity-v1`
5. `lattice-finding-integrity-v1`
6. `lattice-review-pass-integrity-v1`
7. `lattice-review-run-integrity-v1`
8. `lattice-review-scope-binding-v1`
9. `lattice-review-run-workspace-binding-v1`
10. `lattice-scope-check-integrity-v1`
11. `lattice-closeout-write-receipt-integrity-v3`
12. `lattice-final-host-check-v1`
13. `lattice-stall-adjudication-integrity-v1`

Note for CHK-004: `scripts/verify-lattice-residue.mjs`'s self-test currently asserts that
`lattice-review-integrity-v1` is CLEAN. That assertion is correct under this table (the salt is
FROZEN) but its *stated meaning* contradicts the new brand direction and must be reworded, not
deleted.

### The 13 `lattice-`prefixed role IDs (of 17 registry templates)

Verified by `ls packages/main/templates/agents/` — 17 templates total,
`scripts/verify-proof-or-stop-prompt-baseline.mjs:35` pins `EXPECTED_ROLE_COUNT = 17`, of which
13 carry the `lattice-` prefix:

`lattice-evaluator`, `lattice-evaluator-cli`, `lattice-implementer`, `lattice-review-behavior`,
`lattice-review-channel`, `lattice-review-concept`, `lattice-review-delivery`,
`lattice-review-docs`, `lattice-review-quality`, `lattice-review-scope-plan`,
`lattice-review-story-init`, `lattice-review-test-coverage`, `lattice-review-topology-critic`.

The remaining 4 (`implementation-reviewer`, `product-reviewer`, `test-case-reviewer`,
`test-intent`) carry no brand token but are listed above for completeness of the 17-role set.

CLAUDE.md's "16 thin-shim" claim is stale on both counts and is corrected to 13-of-17 in CHK-003.

### Frozen story archives

Verified `grep -rIl -i "lattice" .lattice/story --include='*.md' | wc -l` = **392** at time of
writing, of which **390** predate this story and **2** are B-cdf6's own artifacts
(`.lattice/story/actives/B-cdf6/plan.md`, `background.md`).

The background records 391 as the stable anchor; the live figure necessarily drifts upward while
this story runs, because the story's own markdown artifacts contain the brand token. **390 is
the verified pre-existing count**; treat any single number as approximate and the *path*
(`.lattice/story/**`) as the authoritative freeze boundary, not the count.

## Verdict counts

| Verdict | Rows |
|---|---|
| RENAMED | 8 |
| FROZEN | 15 |
| FROZEN-THIS-STORY | 2 |
| PRESERVE | 1 |
| **Total** | **26** |

## How later items consume this table

- **CHK-002** may rename only rows marked RENAMED that concern the bin and CLI output strings.
- **CHK-003** rewrites active-doc prose and command examples. Every remaining brand-token hit in
  `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/`, `packages/main/templates/` must trace to a
  FROZEN / FROZEN-THIS-STORY / PRESERVE row here. `.lattice/story/**` and `CHANGELOG.md` are
  path-blocked; `git diff --stat` on both must be empty.
- **CHK-004** reconciles the residue gate. It cannot copy the previous rebrand's allowlist-free
  zero-tolerance design, because thousands of legitimate FROZEN-identifier hits exist under
  `packages/*/src`; an exemption model keyed on this table is structurally required.
- **CHK-005** reconciles brand-pinned mechanical gates. Note that `packages/main/src/core/audit-scan.ts:100`
  extracts commands with `/\blattice\s+([a-z](?:[a-z0-9_]*[a-z0-9])?)\b/g`; once docs read
  `proof-or-stop <cmd>` it matches nothing and the drift scan **passes vacuously**. The extractor
  must learn both bin tokens, with a regression test.

### Verdict reconciliation (B-cdf6:F-004, raised by the docs reviewer)

The docs reviewer found the table self-contradictory: the corrected Governing rule above
disavows freezing tokens merely because renaming them needs coordinated edits, yet several
rows below still read `FROZEN` with exactly that coupling-style reasoning. Those rows are
now corrected to **RENAMED (additive)**, matching what was actually implemented:

- Compatible `LATTICE_*` env-var names → routed through the read-both resolver in
  `packages/main/src/core/brand-env.ts`; `PROOF_OR_STOP_*` is canonical where that
  resolver is used. This is not a blanket read-both promise: active validation-shard
  execution reads only `PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER` and does not read or
  accept `LATTICE_VALIDATION_SHARD_ADAPTER`.
- `.lattice/`, `.lattice-serve.json`, `lattice.config.json` → the **identifier names** were
  renamed with deprecated aliases; the **string VALUES** stay frozen, because those are live
  on-disk paths holding the evidence of 32 in-flight stories. Renaming a constant is not the
  same act as renaming the path it points at, and the original table conflated the two.

Still genuinely FROZEN, and re-affirmed under the corrected test: the 13 signature salt
literals (hashed into persisted `_hash` fields), the npm package names (`.githooks/pre-push`
arms on the exact `@lattice/core` string and silently self-disarms on mismatch), the
`<!-- lattice:start -->` managed-block markers, and the `lattice.remote-push-approval.v1`
schema literal.
