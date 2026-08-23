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
| `LATTICE_*` env-var names (146 across 245 files) | Read at runtime; nothing hashes them. Needs read-both compat so existing exports keep working. |
| `bin/lattice.js`, `bin/lattice-codex.js` filenames | Never in the table at all — an outright omission. `init-assets.ts` emits 31 stale invocations into **new user projects**. |
| npm names `lattice`, `@lattice/core` | `.githooks/pre-push:148` arms on the exact string, so it must be updated in the same commit or the gate **silently self-disarms**. That is a sequencing hazard, not evidence. |
| `.lattice/` state dir, `.lattice-serve.json`, `.lattice-codex/`, `lattice.config.json` | Path names. Need read-both compat so existing installs resolve; new writes use the new name. |
| Code identifiers (`runLattice` 129, `LatticeConfig` 44, …) | Pure internal symbols. |

`PRESERVE` remains correct for `ProofStory` (a distinct domain concept, not a brand variant).

Historical `lattice-*` role spellings are compatibility-only legacy reads, not active canonical
identities. B-5a88 owns their migration: new writes emit `proof-or-stop-*`, while exact known
aliases remain readable for in-flight records and unknown role spellings fail closed.

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
| npm package name | Historical compatibility plan: keep `lattice` / `@lattice/core` resolving and add the new name. **SUPERSEDED by the implemented package migrations below:** manifests now write the canonical names; runtime checks retain only the explicit legacy reads they need. |
| `bin/` entries | **SUPERSEDED by B-cc10 CHK-006 (2026-08-17): `bin/lattice.js` and `bin/lattice-codex.js` were removed, not retained.** The replacements are `bin/proof-or-stop.js` / `bin/proof-or-stop-codex.js`; the old retention rationale is preserved only as historical context for why this was a deliberate breaking boundary. The current entrypoint and package bin map are canonical-only. |
| Exported code identifiers | If renamed, **re-export the old symbol as a deprecated alias**, so a teammate's `import { runLattice } from '@lattice/core'` still resolves. A silent build break on merge is the worst outcome: it surfaces as *their* bug in *their* branch. |
| `LATTICE_*` env vars | Read **both** names, preferring the new one. Never *require* the new name. |
| `.lattice/` paths, `lattice.config.json` | Read both; write the new form. Existing installs must keep resolving. |

⚠ **Historical sequencing hazard (resolved):** `.githooks/pre-push:148` used to arm the
recursive-tsc defense by comparing `PKG_NAME` to the exact string `@lattice/core`, and `exit 0` on
mismatch. The package migration widened that check to the canonical and deprecated names before
the manifest changed, so the old silent-disarm path is no longer the current contract.

**CHK-006 re-executed the rename under this corrected test.** Rows below marked RENAMED describe
the current canonical write and any explicit legacy-read compatibility; FROZEN is reserved for
historical values that current verification must preserve.

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

After this story and B-5a88 ship, new runtime output and new writes use canonical
`proof-or-stop-*` role IDs. Historical records may still expose exact `lattice-*` aliases and
`.lattice/` paths; that is intentional compatibility, not an active naming verdict.

---

## Mapping table

| Token shape | Verdict | Replacement (if renamed) | Reason | User-visible in runtime output |
|---|---|---|---|---|
| Prose product name in active docs (`Lattice`, `Proofbound`, and the stray spellings above) | RENAMED | `Proof-or-Stop` | Active docs tell a reader what the product *is* now. `README.md:1` already declares `# Proof-or-Stop`. | Yes — README, CLAUDE.md, `docs/**` prose read `Proof-or-Stop`. |
| CLI bin name / invocation in active docs (`lattice <cmd>`) | RENAMED | `proof-or-stop <cmd>` | Tells a user what to run *now*. This is the core of the user's request. | Yes — every documented command example. |
| `bin/` wrapper entry + `packages/main/package.json` `bin` map | **RENAMED** | `proof-or-stop`; deprecated `lattice` wrappers/bin entry removed by B-cc10 CHK-006 | New package metadata and generated entrypoints write only the canonical bin. The old retention rationale is historical context; the current package publishes only `proof-or-stop`. | Yes — canonical `proof-or-stop` entrypoint. |
| `LATTICE_PRIMARY_BIN` (`packages/main/src/core/lattice-brand.ts:5`, currently `'lattice'`) | RENAMED | `'proof-or-stop'`, with help/usage lines consuming `brand.invokedAs` | `help-renderer.ts` derives 11 `Usage:` lines from this constant (`:182`, `:210`, `:236-241`, `:304-305`), so `proof-or-stop help` would otherwise print `Usage: lattice ...` — the CLI would teach the old brand. | Yes — all `Usage:` / `Entrypoint:` lines. |
| `LATTICE_PRODUCT_NAME` (`packages/main/src/core/lattice-brand.ts:4`, currently `'Proofbound CLI'`) | **RENAMED** | `'Proof-or-Stop'` | **Ruling for CHK-001.** `lattice --version` prints `Proofbound CLI 0.3.251` today (verified). `Proofbound` is a legacy spelling on the normalize list, not an approved prose form, and `README.md:96` explicitly flags it as a rename in progress. `--version` states what the product *is now*, so it is RENAMED. | Yes — `proof-or-stop --version` prints `Proof-or-Stop <version>`. |
| Literal `# lattice session brief` header (`packages/main/src/handlers/session.ts:777`) | RENAMED | `# proof-or-stop session brief` | The most-seen string in the product, given CLAUDE.md rule 0. Tells the user which tool they are in. Pinned by `scripts/verify-entrypoints.mjs:277` and `:515`, which must be updated in the same commit. | Yes — first line of every `session_brief`. |
| Hardcoded `lattice <cmd>` hints and error strings in `cli-engine.ts` | RENAMED | `proof-or-stop <cmd>` (mirroring `invokedAs`) | Next-action guidance, i.e. what to run next. | Yes — error and hint text. |
| Help / usage output strings generally | RENAMED | derived from `brand.invokedAs` | Output should mirror how the CLI was actually invoked. | Yes. |
| **The 13 signature salt literals** (see enumeration below) | **FROZEN** | — | Each salt is hashed into `_hash` fields **already persisted** on live artifacts. Renaming a salt silently invalidates every stored signature, so active stories would immediately read as tampered and gate-block. These record what already happened. | Indirect — appears in no normal output, but a corrupted signature would surface as `*_tampered` gate blockers. |
| `.lattice/` state directory → `.proof-or-stop/` | **RENAMED with legacy-read compatibility** | `.proof-or-stop/` | New state writes use the canonical directory. Resolvers still read the deprecated `.lattice/` directory so existing installations and historical records remain accessible; archived story contents themselves remain frozen. | Canonical paths are used for new output; legacy paths may appear when compatibility reads resolve them. |
| `.lattice-serve.json` (the NAME; its VALUE is frozen) | **RENAMED (additive)** | — | Runtime discovery file written by `serve` and read back by tooling; renaming breaks the read side. (Runtime-generated; gitignored, absent from a clean tree.) | Yes — referenced in debugging docs and by `serve` output. |
| `.lattice-codex/` / `lattice.json` adapter identities | **RENAMED with legacy-read compatibility** | `.proof-or-stop-codex/` / `proof-or-stop.json` | Init and adapter writers use the canonical directory and manifest. Adapter resolution probes canonical first and the deprecated directory/filename combinations for existing installations; deprecated forms are never written. | Canonical paths in new assets; deprecated paths only in compatibility diagnostics. |
| **The 13 `lattice-`prefixed agent role IDs** (of 17 total registry templates; see enumeration below) | **RENAMED with legacy-read compatibility** | `proof-or-stop-*` | B-5a88 migrates the canonical role identity and alias mapping. New writes emit canonical IDs; exact known `lattice-*` aliases remain readable for historical/in-flight records and are the only legacy spellings managed by `--upgrade`. | **No for new writes** — historical records may still show the alias. |
| The 4 non-`lattice-` role IDs (`implementation-reviewer`, `product-reviewer`, `test-case-reviewer`, `test-intent`) | **RENAMED with legacy-read compatibility** | `proof-or-stop-*` | B-5a88 applies the same canonical role identity mapping. New writes emit canonical IDs; exact mapped aliases remain readable only for compatibility. | **No for new writes** — historical records may still show the alias. |
| **390 frozen story archives** under `.lattice/story/` (markdown containing the brand token) | **FROZEN** | — | CLAUDE.md rule 8 forbids direct writes under the story directory; all story mutation goes through the CLI. These are historical records — rewriting them falsifies the audit trail. | Yes — quoted back in `story_get` / `session_brief` output. |
| `packages/main` npm package name `@lattice/core` → `@proof-or-stop/core` | **RENAMED with legacy-read compatibility** | `@proof-or-stop/core` | Package manifests, lockfiles, dependencies, and generated imports write the canonical name. Runtime self-project checks and global package discovery still recognize `@lattice/core` as an explicit deprecated read; no deprecated alias package is published. | No — package identity is visible in package metadata and diagnostics only. |
| Root npm package name `lattice` → `proof-or-stop` | **RENAMED with legacy-read compatibility** | `proof-or-stop` | The root manifest and lockfile write `proof-or-stop`. Runtime self-project detection still accepts `lattice` while an older checkout is upgraded; it is not a current write identity. | No. |
| Sibling npm package names `@lattice/utils`, `@lattice/lab` → `@proof-or-stop/utils`, `@proof-or-stop/lab` | **RENAMED** | canonical `@proof-or-stop/*` names | Sibling manifests, lockfiles, dependencies, and source-facing package references now write the canonical names. No runtime alias package or legacy package read is part of this migration. | No. |
| `lattice.config.json` → `proof-or-stop.config.json` | **RENAMED with legacy-read compatibility** | `proof-or-stop.config.json` | New config writes use the canonical filename. The resolver reads the deprecated filename as a fallback and warns, so existing projects remain loadable. | Yes — named in `proof-or-stop init` output as the canonical project config. |
| `LATTICE_*` environment-variable prefix (56 distinct vars verified under `packages/*/src`) | **RENAMED (additive)** | — | Env vars are an external contract with CI, shells and operator scripts. Renaming breaks every existing invocation with no deprecation path in this story. | Yes — documented in CLAUDE.md (e.g. `LATTICE_SESSION_BRIEF_FRESH_MINUTES`, `LATTICE_BRIEF_OUTPUT`). |
| `<!-- lattice:start/end -->` managed-block markers | **RENAMED with legacy-read compatibility** | `<!-- proof-or-stop:start/end -->` (and profile equivalents) | Init and sync writers emit the canonical markers. The structured parser accepts exact legacy marker families so existing managed blocks can be read and migrated; mixed or malformed families still fail closed. | Canonical markers in new managed assets; legacy markers may remain in unmigrated files. |
| `lattice.remote-push-approval.v1` → `proof-or-stop.remote-push-approval.v1` | **RENAMED with legacy-read compatibility** | `proof-or-stop.remote-push-approval.v1` | `release-push-approval.ts` writes the canonical schema under the canonical state path. The pre-push hook accepts the exact deprecated schema for an existing unexpired approval, so a historical approval remains usable without making the legacy schema a new write. | Indirect — canonical approvals are created now; legacy approvals are accepted only during compatibility reads. |
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

### Canonical role-template IDs and historical compatibility reads (B-5a88 supersession)

The current 17-template registry and `packages/main/templates/agents/` emit canonical
`proof-or-stop-*` role IDs. The active `promptEnvelope.roles` configuration in
`proof-or-stop.config.json` uses those same canonical IDs. Exact historical `lattice-*` IDs
remain reader-only compatibility spellings through the explicit `agent-role-identity.ts`
mapping; they are accepted for old or in-flight records and are never emitted by current
templates, registry output, or configuration. No other `lattice-*` spelling is an alias for
these template roles.

The 13 historical `lattice-*` IDs map to these canonical role IDs:

| Historical compatibility read | Canonical emitted role ID |
|---|---|
| `lattice-evaluator` | `proof-or-stop-evaluator` |
| `lattice-evaluator-cli` | `proof-or-stop-evaluator-cli` |
| `lattice-implementer` | `proof-or-stop-implementer` |
| `lattice-review-behavior` | `proof-or-stop-review-behavior` |
| `lattice-review-channel` | `proof-or-stop-review-channel` |
| `lattice-review-concept` | `proof-or-stop-review-concept` |
| `lattice-review-delivery` | `proof-or-stop-review-delivery` |
| `lattice-review-docs` | `proof-or-stop-review-docs` |
| `lattice-review-quality` | `proof-or-stop-review-quality` |
| `lattice-review-scope-plan` | `proof-or-stop-review-scope-plan` |
| `lattice-review-story-init` | `proof-or-stop-review-story-init` |
| `lattice-review-test-coverage` | `proof-or-stop-review-test-coverage` |
| `lattice-review-topology-critic` | `proof-or-stop-review-topology-critic` |

The four formerly non-branded template IDs are also emitted with canonical names:
`proof-or-stop-implementation-reviewer`, `proof-or-stop-product-reviewer`,
`proof-or-stop-test-case-reviewer`, and `proof-or-stop-test-intent`. Their exact historical
spellings remain compatibility reads only, as registered by the same runtime identity map.

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
| RENAMED | 16 |
| FROZEN | 10 |
| FROZEN-THIS-STORY | 0 |
| PRESERVE | 1 |
| **Total** | **27** |

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

- `LATTICE_*` env-var names → routed through the read-both resolver in
  `packages/main/src/core/brand-env.ts`; `PROOF_OR_STOP_*` is canonical, the old name is
  still read and dual-written so a pre-rename reader also keeps working.
- `.lattice/`, `.lattice-serve.json`, `lattice.config.json` → the **identifier names** were
  renamed with deprecated aliases; the **string VALUES** stay frozen, because those are live
  on-disk paths holding the evidence of 32 in-flight stories. Renaming a constant is not the
  same act as renaming the path it points at, and the original table conflated the two.

Still genuinely FROZEN, and re-affirmed under the corrected test: the 13 signature salt
literals (hashed into persisted `_hash` fields), protocol identifiers such as
`__LATTICE_WS_PORT` / `LATTICE_SHELL`, archived story content, published external identifiers,
and other values whose historical bytes are directly verified. Package names, managed markers,
and the remote-push approval schema are active migrations now; their deprecated spellings appear
only in the explicit compatibility reads documented above.
