# Proof-or-Stop identity migration (B-cc10)

Retires the six `lattice` identities that B-cdf6 deliberately left in place. B-cdf6 renamed the
user-facing CLI surface; this story renames the **structural** identities: on-disk state
directories, config/manifest filenames, the workspace package name, and the deprecated bin
aliases.

Scope source: the operator enumerated exactly six items. Anything not in that list stays frozen,
and each exclusion below carries its own basis rather than being a convenience.

## Per-identity verdicts

| Identity | Verdict | Reason |
|---|---|---|
| `bin/lattice.js`, `bin/lattice-codex.js` | **REMOVED** (irreversible; last) | Operator item 1. Supersedes the compatibility guarantee — see Supersession 2. |
| `.lattice/` → `.proof-or-stop/` | **RENAMED with migration** | Operator item 2. `brand-rename-mapping.md:124` already gives this row the verdict RENAMED (additive). ~7580 tracked files, 344 archives; `git mv` so history follows. |
| `.lattice-codex/` → `.proof-or-stop-codex/` | **RENAMED with migration** | Operator item 3. Adapter resolves by exact name, so the resolver must own it. |
| `lattice.config.json` → `proof-or-stop.config.json` | **RENAMED, read-both** | Operator item 4. Deprecated filename stays readable; only canonical is written. |
| `lattice.json` → `proof-or-stop.json` | **RENAMED, read-both** | Operator item 5. Adapter manifest. |
| `@lattice/core` → `@proof-or-stop/core` | **RENAMED** | Operator item 6. Its prior freeze is superseded — see Supersession 1. |

## Deliberately FROZEN — out of scope

| Identity | Basis |
|---|---|
| 8 `lattice-*-integrity-v1` signature salts | Standalone string constants (`core/finding-verify.ts` + 6 siblings), independent of any path or filename. Renaming would invalidate every historical signature. Verified by the INIT reviewer. |
| 13 `lattice-*` agent role IDs | `subagent_type` values; owned by `proof-or-stop-agent-prompt-consolidation-execution-plan.md`. Renaming breaks spawning for in-flight stories. |
| ROOT npm package name `lattice` | Not among the operator's six. `brand-rename-mapping.md:131`. Verified publishable (`package.json` has no `private: true`), so it is a registry-identity action for its own story. Raised as scope-plan **OQ-2** after being a silent omission. |
| Managed-block markers `<!-- lattice:start/end -->` | `brand-rename-mapping.md:134` — "changing the marker orphans every existing managed block." |
| `lattice.remote-push-approval.v1` schema literal | `brand-rename-mapping.md:135` — exact-match string compared in `core/release-push-approval.ts` and `.githooks/pre-push:78`; a one-sided rename breaks release approval. |
| `LATTICE_*` env keys as STORED keys | Already read-both via `core/brand-env.ts` (B-cdf6). Not re-litigated here. |
| `__LATTICE_WS_PORT`, `LATTICE_SHELL` | Hardcoded protocol identifiers across 5 source files; a protocol change, not a diagnostics edit. Disclosed B-cdf6 follow-up. |
| Content inside archived story files | History MOVES via `git mv`; it is never edited. |

## Two deliberate supersessions of prior FROZEN verdicts

Recorded explicitly so a reader sees evidence-based overrides rather than ignored rows.

**1. `@lattice/core` (scope-plan OQ-1).** `brand-rename-mapping.md:130` froze it because
`.githooks/pre-push` gated the recursive-tsc defence on `PKG_NAME = "@lattice/core"` and
`exit 0`s on mismatch — renaming would **silently self-disarm** the hook. That premise is now
**stale relative to the code**: the case statement reads

```
'@lattice/core'|'@proof-or-stop/core')
```

pre-widened by B-cdf6 precisely so a later rename could not disarm it. Independently confirmed by
both the scope-plan reviewer and the intent-collision reviewer, each grepping the hook themselves.
CHK-005 must still grep for OTHER exact-name consumers rather than assuming pre-push was the only
one.

**2. The bin aliases.** `brand-rename-mapping.md:72` documents that `bin/lattice.js` "keeps
working" for multi-developer compatibility. The operator's item 1 says 移除 (remove). The explicit
instruction supersedes the documented guarantee. Handling: CHK-006 is sequenced **last**, requires
a CHANGELOG entry naming both removed aliases and their replacements, and required PLAN to choose
and record warn-then-remove vs immediate cut. **Decision recorded: immediate removal, with the
CHANGELOG entry as the announcement** — the product reviewer judged a mandatory warn-then-remove
phase disproportionate for a single-developer project with a tight release cadence, and set the
changelog as the floor rather than optional.

## storyFilesHash: the state-dir rename is a CHK-002 correctness requirement

This began as an open unknown, was twice reasoned about incorrectly, and is now settled
**empirically**. Both wrong routes are recorded because the risk was reached by a bad path first.

Algorithm (`story-files-hash-material-drift.md:25-32`): step 4 excludes story metadata and runtime
artifacts; step 5 hashes each remaining `path + blob-object-id`, sorted **by path**.

Measured against the built `dist`:

```
isStoryMetadataPath:
  true    .lattice/story/actives/B-cdf6/index.json
  false   .proof-or-stop/story/actives/B-cdf6/index.json

isMaterialExcludedRuntimeArtifactPath:
  false   .lattice-codex/lattice.json
  false   .proof-or-stop-codex/proof-or-stop.json
  false   lattice.config.json
  false   proof-or-stop.config.json
```

**Finding.** Archive paths are excluded today, but only because the prefix derives from
`PROOF_OR_STOP_STORY_DIR` = `${PROOF_OR_STOP_DIR}/story/actives` (`core/lattice-paths.ts:13`),
whose value is still `.lattice`. After the rename, 344 archives flip from **excluded** to
**included** in `storyFilesHash` unless that constant moves with them. The failure mode is
**silent** — nothing errors; the hashes just change meaning.

**Consequence.** This is not a CHK-003 problem to clean up after the move. It is a **CHK-002
correctness requirement**: `PROOF_OR_STOP_DIR` must be the single source the resolver owns, so
`isStoryMetadataPath` follows the rename automatically. CHK-002 acceptance must include:
post-rename, `isStoryMetadataPath('<newdir>/story/actives/...')` returns `true`.

**Adapter and config paths are symmetric** (all four `false` above) — they are material under both
old and new names, so the rename introduces no asymmetry there. The hazard is isolated to the
story-dir prefix.

Two superseded readings, kept for audit:
- "Paths are hashed, so the rename shifts all 344 archives" — cited step 5 while skipping step 4.
- "Archives are excluded, so nothing shifts" — true only of the *current* layout.

## Acceptance criterion

All 344 archived story directories remain readable after migration and their historical signatures
still verify. CHK-003 must demonstrate this on **two named archives from different eras** (one
earliest-era, one immediately pre-migration), named in evidence — not one convenient recent story.

## CHK-005 execution record: `@lattice/core` → `@proof-or-stop/core`

### Decision: clean break, NO deprecated alias package

**Chosen: clean break.** No `@lattice/core` alias package is published.

Rationale, in the order the evidence actually forced it:

1. **Nothing in-repo imports the package by name.** The rename was expected to touch "~19 source
   import sites". It did not: a repo-wide sweep found **zero** real `import ... from
   '@lattice/core'` statements in `packages/*/src`. `packages/utils` and `packages/lab` declare
   core as a dependency but reach main through **relative paths into `packages/main/dist`**, not
   through the package name. So no internal consumer needs the old name to resolve.
2. **The only name-shaped "import" is a generated template**, `cli-init.ts` emitting a `debug.ts`
   scaffold into *user* projects. That is a codegen output string, not a resolution edge — and it
   is handled by keeping a read-both bootstrap candidate list (below), not by an alias package.
3. **An alias package would have to be published to be useful.** This package publishes to a
   GitHub registry (`publishConfig.registry`). Publishing a second package to redirect a name no
   in-repo code resolves is registry-identity work with a maintenance tail, for zero measured
   consumer. That is the same publish-level scope the OQ-2 exclusion deliberately defers.
4. **Read-both fallbacks cover the real compatibility risk**, which is not name *resolution* but
   an **already-installed global** `@lattice/core` on a developer's machine. Handled in code (below).

Consequence accepted: an external project that hardcodes `@lattice/core` in its own
`package.json` must update that reference. This is a **single-developer repo with no external
dependents**, so the multi-developer "silent build break on merge" hazard that
`brand-rename-mapping.md:73` warns about does not apply to a name nothing imports.

### Read-both compatibility (what was added instead of an alias)

Canonical is the only name **written**; the deprecated name is still **read**:

- `core/runtime-environment-checks.ts` — `SELF_CORE_PACKAGE_NAMES` accepts either spelling for
  self-project detection; `resolveCorePackageCandidate` probes canonical then deprecated.
- `handlers/worktree.ts` — global relink probes both scope directories.
- `core/codex-adapter-checks.ts` — global fallback heartbeat probes both.
- `init-assets.ts` — the generated bootstrap keeps `node_modules/@lattice/core/...` as a
  **fallback candidate after** the canonical path, so a project scaffolded before the rename
  still boots. Pinned by `scripts/verify-entrypoints.mjs` on both candidates.

### Exact-name consumers found by sweeping BEFORE renaming

`brand-rename-mapping.md:130` justified the freeze solely via `.githooks/pre-push`. Pre-push was
indeed already widened (`'@lattice/core'|'@proof-or-stop/core')`, but it was **not the only**
exact-name consumer. Four more sat inside **comparisons/predicates** — the B-cdf6 regression class,
where the canonical spelling silently fails while the old one works:

| Site | Failure mode had it not been updated |
|---|---|
| `core/rollout-check.ts` `isSelfLayout` | **Silent disarm.** A miss makes `ok` short-circuit to `true`, so the version-sync/wrapper check passes vacuously. |
| `handlers/test-auto.ts` self-test refusal | **Silent disarm of a self-protection guard.** A miss lets `test_auto` run the full suite against the framework itself. |
| `core/runtime-environment-checks.ts` `detectSelfProject` | A miss flips `runtimeScope` self→external, downgrading drift checks to advisory. |
| `core/codex-adapter-checks.ts` global candidates | A miss makes an installed global look absent, skipping the heartbeat. |

Two guard scripts pinned the literal and **fail loudly** (not silently), so they were updated in
the same commit: `scripts/verify-runtime-fact-contract.mjs` and
`scripts/verify-global-lab-entrypoint.mjs`. `core/prompt-registry.ts`'s
`PROMPT_REGISTRY_SOURCE` is package-name-derived and is compared by
`scripts/verify-proof-or-stop-prompt-baseline.mjs`, so registry + baseline were updated together.

### Out of scope, verified untouched

- **ROOT `package.json` name stays `lattice`** (OQ-2). Mechanically pinned by
  `scripts/verify-core-package-rename.mjs`, which exits non-zero if the root is ever renamed —
  so a future "finish the rename" sweep breaks the build instead of quietly crossing the boundary.
- **Sibling package names `@lattice/utils` / `@lattice/lab` are NOT renamed.** The operator
  enumerated `@lattice/core` specifically. Only their *dependency reference* to core moved.
- `CHANGELOG.md` untouched (FROZEN, historical release record).

### Known residual drift for CHK-007 (reported, deliberately not fixed here)

`scripts/verify-lattice-residue.mjs` holds a fixture asserting
`"import { devHost } from '@lattice/core/dev-host';"` is **exempt**, commented
"npm package name (FROZEN — pre-push hook gates on it)". That exemption rationale is now stale.
Correspondingly `CLAUDE.md:192` still documents the old `@lattice/core/dev-host` import in its
`debug.ts` example while `cli-init.ts` now emits the canonical spelling. Both belong to CHK-007,
which owns flipping `@lattice/core` from exempt to **forbidden** in product runtime source.
