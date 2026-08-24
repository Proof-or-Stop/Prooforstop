# Proof-or-Stop identity migration (B-cc10)

Retires the six `lattice` identities that B-cdf6 deliberately left in place. B-cdf6 renamed the
user-facing CLI surface; this story renames the **structural** identities: on-disk state
directories, config/manifest filenames, workspace package identities, managed markers, the
remote-push approval schema, and the deprecated bin aliases.

Scope source: the operator enumerated exactly six structural items. That scope remains the
boundary for B-cc10; a later approved migration may supersede a freeze when its compatibility
contract is explicit. B-5a88 supersedes the earlier agent-role freeze: canonical
`proof-or-stop-*` role IDs are emitted for new writes, while `lattice-*` role IDs remain
compatibility-only legacy reads. The package, managed-marker, and remote-approval migrations
listed below are likewise current canonical writes with narrowly explicit legacy reads.

## Per-identity verdicts

| Identity | Verdict | Reason |
|---|---|---|
| `bin/lattice.js`, `bin/lattice-codex.js` | **REMOVED** (irreversible; last) | Operator item 1. Supersedes the compatibility guarantee — see Supersession 2. |
| `.lattice/` → `.proof-or-stop/` | **RENAMED with migration** | Operator item 2. `brand-rename-mapping.md:124` already gives this row the verdict RENAMED (additive). ~7580 tracked files, 344 archives; `git mv` so history follows. |
| `.lattice-codex/` → `.proof-or-stop-codex/` | **RENAMED with migration** | Operator item 3. Adapter resolves by exact name, so the resolver must own it. |
| `lattice.config.json` → `proof-or-stop.config.json` | **RENAMED, read-both** | Operator item 4. Deprecated filename stays readable; only canonical is written. |
| `lattice.json` → `proof-or-stop.json` | **RENAMED, read-both** | Operator item 5. Adapter manifest. |
| `@lattice/core` → `@proof-or-stop/core` | **RENAMED, canonical-write plus legacy-read** | Package manifests and dependencies write `@proof-or-stop/core`; self-project checks and global package discovery still recognize `@lattice/core` as a deprecated read. No alias package is published. |
| Root npm package `lattice` → `proof-or-stop` | **RENAMED, canonical-write plus legacy-read** | Root package and lockfile write `proof-or-stop`; runtime self-project detection accepts `lattice` only for older checkouts. |
| Sibling npm packages `@lattice/utils`, `@lattice/lab` → `@proof-or-stop/utils`, `@proof-or-stop/lab` | **RENAMED** | Package manifests, lockfiles, dependencies, and source-facing references write the canonical names. No deprecated alias packages are published or read by the runtime. |
| Managed markers `<!-- lattice:start/end -->` → `<!-- proof-or-stop:start/end -->` | **RENAMED, read-both** | Init/sync writes the Proof-or-Stop marker family; the structural parser reads exact legacy marker families so existing managed blocks can be migrated, and rejects mixed or malformed markers. |
| `lattice.remote-push-approval.v1` → `proof-or-stop.remote-push-approval.v1` | **RENAMED, canonical-write plus legacy-read** | Approval creation writes the Proof-or-Stop schema; the pre-push hook accepts the exact legacy schema only for already-created approvals. |

## Historical values deliberately FROZEN — not active identity rows

| Identity | Basis |
|---|---|
| 13 `lattice-*-integrity-v1` signature salts | Standalone string constants (`core/finding-verify.ts` + sibling verifiers), independent of any path or filename. Renaming would invalidate every historical signature. |
| `LATTICE_*` env keys as STORED keys | Already read-both via `core/brand-env.ts` (B-cdf6). Not re-litigated here. |
| `__LATTICE_WS_PORT`, `LATTICE_SHELL` | Hardcoded protocol identifiers across 5 source files; a protocol change, not a diagnostics edit. Disclosed B-cdf6 follow-up. |
| Content inside archived story files | History MOVES via `git mv`; it is never edited. |

## Agent-role verdict supersession (B-5a88)

The earlier frozen verdict for the 13 `lattice-*` role IDs is superseded by the implemented
role-identity migration. The canonical `proof-or-stop-*` role ID is the only spelling emitted by
new prompt, dispatch, reviewer, and migration writes. The exact `lattice-*` aliases remain
readable for historical in-flight records and are compatibility-only; unknown role spellings are
not accepted by the role registry. Project-local Claude `--upgrade` removes only canonical role
basenames and their known legacy aliases, preserving unrelated user-authored files.

## Two deliberate supersessions of prior FROZEN verdicts

Recorded explicitly so a reader sees evidence-based overrides rather than ignored rows.

**1. `@lattice/core` (scope-plan OQ-1).** The earlier mapping froze it because
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

**2. The bin aliases.** An earlier mapping documented that `bin/lattice.js` "keeps working" for
multi-developer compatibility. The operator's item 1 says 移除 (remove). The explicit instruction
superseded that documented guarantee. Handling: CHK-006 was sequenced **last**, required
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

**PATHS ARE HASHED** — not just file contents (`story-files-hash-material-drift.md:30-31`).
This is why renaming a directory can move `storyFilesHash` even when every byte of content is
identical, and it is the reason the state-dir rename had to be treated as a CHK-002
correctness requirement rather than CHK-003 cleanup.

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

### Migration status and historical boundaries

- **ROOT `package.json` name is now `proof-or-stop`**, and the package identity migration test
  binds the root manifest and lockfile to that canonical name. Runtime self-project detection
  retains the deprecated `lattice` spelling as a bounded read for older checkouts.
- **Sibling packages are now canonical**: `@proof-or-stop/utils` and `@proof-or-stop/lab`, with
  canonical dependency and lockfile entries. There is no published alias-package contract for
  their deprecated names.
- **Managed assets and remote approvals are canonical-write migrations**: generated blocks use
  `proof-or-stop` markers and approval creation uses `proof-or-stop.remote-push-approval.v1`;
  exact legacy forms remain only at the readers named in the active rows above.
- `CHANGELOG.md` records the release announcement for the root and the explicit sibling
  package renames (`@proof-or-stop/utils` and `@proof-or-stop/lab`); it is historical
  release documentation, not an unchanged-package exception.

### CHK-007 residue decision (resolved by B-5a88)

`scripts/verify-lattice-residue.mjs` now uses the canonical
`"import { devHost } from '@proof-or-stop/core/dev-host';"` fixture. The deprecated
`@lattice/core` spelling is not a frozen runtime exception: CHK-007 forbids it at
product decision sites, while the pre-push reader retains the explicitly documented
legacy compatibility check.
~~Correspondingly `CLAUDE.md:192` still documents the old `@lattice/core/dev-host` import in its
`debug.ts` example.~~ **RETRACTED (B-cc10 F-066):** that half was already false when written —
`CLAUDE.md:192` reads `@proof-or-stop/core/dev-host` at this HEAD, renamed within this story's own
diff. A reader following the claim would hunt a defect that does not exist. The residue-script
fixture is now canonical as recorded above, while check 4 still forbids deprecated `@lattice/core`
decision sites in product runtime source.

The F-066 note also records the related self-repo detection wording drift: `CLAUDE.md:1070` and
the `.githooks/pre-push` header now describe the canonical `@proof-or-stop/core` name together
with the bounded legacy read. The hook's name-set comparison remains intentional so a later rename
cannot silently disarm the recursive tsc gate.

## CHK-008 revert claim: RETRACTED (B-cc10 F-007)

The CHK-008 adversarial intent originally claimed: *"`git revert <sha>` alone restores the
pre-move layout with no manual fixup"*, evidenced by the move commit's diffstat being a pure
rename. **That claim was false.** The state-dir move is a two-commit sequence:

| Commit | Nature |
|---|---|
| `ec7f315e0a` | the `git mv` itself — genuine pure rename, 0 insertions / 0 deletions |
| `8c0bd7b87c` | required follow-up — 7594 files, 523 insertions: fixes a nested-mv defect and re-flips the canonical constants |

The witness had been validating only the first commit's diffstat, so it confirmed a property
nobody disputed while leaving the actual claim untested. The `lattice-review-test-coverage`
reviewer caught it and reproduced the failure: `git revert ec7f315e0a` on current HEAD produces
dozens of file-location conflicts rather than a clean restore.

**Corrected claim, now asserted mechanically:** the move is fully described by a bounded,
reachable commit *sequence*; the `mv` commit itself is content-preserving; and reverting the
move means reverting **both** commits, not a single sha. `scripts/verify-migration-contract.mjs`
checks exactly that and fails closed if either commit becomes unreachable.

This is recorded rather than quietly amended because the original evidence was cited as
satisfying a `must` intent, and a reader comparing the intent to reality deserves to see that
the mismatch was found by review, not by the author.

## Residual: 52 task fixtures still construct the deprecated state dir (B-cc10 F-001)

`packages/main/src/tasks` has ~52 files (~180 occurrences) that hardcode `'.lattice'` when
BUILDING temp-dir fixtures, e.g. `deprecated-gc-smoke.ts:39` does `mkdirSync(join(tmp,'.lattice'))`
and then calls a resolver-based reader.

**The predicted breakage did not materialise, and that was verified rather than assumed.** The
concern was that once `PROOF_OR_STOP_STATE_DIR` flipped, fixture-writer and production-reader
would disagree and these smokes would fail. They pass: read-both means the resolver still
resolves the deprecated spelling, so writer and reader still agree. `deprecated-gc-smoke` was run
post-flip and passes.

**What remains true** is a coverage gap rather than a break: those fixtures exercise the
PRE-migration on-disk shape, so they no longer test the layout a fresh project now gets. They are
therefore load-bearing for the read-both path and NOT for the canonical path.

**Deliberately not bulk-rewritten in this story.** A blind sweep of 180 occurrences across 52
files would be exactly the mistake this story already made once with `CLAUDE.md`: a
whole-file/whole-class rewrite where a targeted, reasoned edit was correct. Several of these
fixtures legitimately test deprecated-path handling, so flipping them all would DELETE the
coverage that proves read-both works. Distinguishing per-file requires reading each fixture's
intent, which is its own scoped task.

Recorded here so it is a known, bounded residual with a stated reason, not an omission.

## Validate suite state at close (B-cc10)

The rename broke **25 of 104** validate commands. Review then found more, in two waves, and
the count has been corrected twice because each wave arrived after the previous total was
written — so treat any single number here as a floor, not a ceiling:

| Wave | Count | Why the suite could not have counted them |
|---|---|---|
| Measured by validate | 25 | ordinary failures |
| Vacuously-passing guards (F-054/F-055/F-056) | +3 | scan roots named the renamed adapter dir, so they scanned zero files and reported PASS |
| Found after the "28" was written (F-057, F-061, the second CLAUDE.md/AGENTS.md destruction, the second `**/*.lock/` loss, F-062) | +5 | four were self-inflicted during repair, not rename fallout; one was a fix that was not durable |
| Gate-blind literals (F-064 policy keys + `approvedRoots`, F-065 doc comments) | +2 | the retired literal was a DATA VALUE in a policy table, compared one level removed via `pathIsContained()`; the `[brand-decision]` regex only sees direct comparisons |
| Missed WRITE path + missing witness (F-067, F-068) | +2 | F-067: dead deprecated-dir `mkdirSync` in the same file I had claimed was fully routed. F-068: one of the five F-064 sites had NO witness — reverting it left all four named suites green, because that key only feeds `claimsConflict()` string equality, so a regression degrades scheduling SILENTLY instead of throwing |
| Doc claims false when written (F-063, F-066, F-069) | +0 | not validate defects — counted separately below; recorded because three separate reviewer rounds caught this file asserting things about itself that were not true |

Every later wave is a ROW in that table rather than prose appended after it — B-cc10 F-069 was
filed because a running-commentary sentence said "one more arrived" for what were actually two
defects (F-064/F-065). Prose that trails a table decays every time the number moves; rows do not.

F-064 deserves its own note because it widens the "invisible" class above. The
`[brand-decision]` gate flags the retired literal when it appears in a comparison
(`.startsWith` / `.includes` / `===` / `!==`). In `full-suite-runner.ts` the literal was a
**data value** — fed into a `RESOURCE_POLICY` table and only compared one level removed, via
`pathIsContained()` and `target === approved`. A regex over comparison expressions cannot see
that, so the gate passed while product runtime source still hardcoded the retired directory.

The latent hazard there was not the policy keys but the `approvedRoots` containment allowlist:
a cleanup safety check pinned to the DEPRECATED dir would have started throwing "outside an
approved owned root" the moment the runtime wrote a cleanable target under the canonical one. A
safety check pinned to the old spelling fails in the *safe-looking* direction — it refuses to
clean up — which is why nothing surfaced it until a reviewer read the data flow by hand.

**Generalisation:** grep-shaped gates see literals in the positions the gate author imagined.
Prefer making the retired spelling *unrepresentable* (resolver-derived helpers) over adding
another pattern to the gate.

**Honest total: 37 validate-suite defects fixed**, of which 8 were invisible to the suite used
to measure the first 25. **All 37 are fixed.**

Do not confuse that 37 with the reviewer-finding ledger, which counts something different: 37
is defects that broke the validate suite (a CLOSED set, so the number is stable); the ledger is
everything the reviewer rounds raised — docs drift, dead code, vacuously-passing fixtures, and
overclaims in this very file — and it kept growing until the last round closed.

**The ledger total is deliberately NOT quoted here.** Read it from the source:

```bash
node -e "const j=require('./.proof-or-stop/story/actives/B-cc10/findings.json');const a=j.findings||j;const r=Array.isArray(a)?a:Object.values(a);const s={};r.forEach(x=>s[x.status]=(s[x.status]||0)+1);console.log(r.length,s)"
```

Five separate reviewer rounds (F-060, F-063, F-069, F-072, and one before them) caught a stale
ledger count in this file, because every fix to the count is itself a resolve that changes the
count — the number was stale again the moment it was written, including the commits that
"fixed" it. A snapshot of a live counter cannot be kept accurate by editing it more carefully;
the only durable fix is to stop snapshotting and point at the source. Three findings were
critical.

Final state:
`status=pass`, `allPass=true`, verification coverage **24/24** (21 mechanical receipts +
3 audited permanent waivers).

Precise reading of the final run: it reports `commandExecutions=0` because it REUSED a
trusted prior PASS (`trusted-story-metadata-descendant`) instead of re-executing. The
104/104-commands figure therefore comes from the last full execution, not from that run.
Stated explicitly so nobody reads a reused PASS as 104 fresh executions.

An earlier revision of this section said "23 were fixed; 2 remain" and declared both
remaining tests NOT this story's defects. **That was wrong on both counts and is retracted**
(reported as F-039 by the docs reviewer — the same overclaim pattern it caught as F-035):

| Then claimed | What was actually true |
|---|---|
| `validation-reuse-merge-lineage-smoke` — "not a defect, suite interference only" | Right about the CAUSE (7 teardowns used `rmSync` recursive+force with no retries and lost a race in-suite), wrong to leave it. The TEST gate consumes validate's pass/fail, not the author's rationale. Fixed with `maxRetries`/`retryDelay`. |
| `proofstory-acceptance-basis-smoke` — "pre-existing on main, independent of the rename" | It DID fail on main, but only because main carries the same rename-induced cause. Two stacked defects, both this story's: a readability-probe that made a symlinked config look ABSENT, and a mutation regex pinned to the OLD brand string so the negative control silently stopped controlling. |

The lesson: "it also fails on main" is not evidence that a defect is unrelated to your change,
and "it only fails in the suite" is not a reason to leave a gate red.

### The dominant defect class, and why it matters

Nearly every one of the 23 was the same shape: **a fixture setting up state at a path the
runtime had stopped reading.** Three sub-kinds, in ascending order of danger:

1. **Loud** — `ENOENT` / `pathspec did not match`. Self-announcing.
2. **Quiet** — a fixture writes config or a gitignore the runtime never reads, so a guard
   silently returns the wrong verdict (`parallel-decomposition`: `canStartDevGuard` FALSE
   because `audit-config.json` was written where nothing read it).
3. **Dangerous — sabotage that misses.** Tests that force failures by breaking a file
   (`experience.jsonl` replaced with a directory, a planted broken `evidence/refs/by-id`)
   did so at the deprecated path. After the rename the sabotage missed entirely: the
   operation SUCCEEDED, the expected exception never fired, and the assertions passed
   vacuously. `dev-memory-lifecycle-gates` had TWO such sites, the first masking the second.
   **A test whose sabotage misses still reports green — strictly worse than a red test.**

4. **Invisible — runtime-GENERATED text (B-cc10 F-041, F-047..F-050, F-054).** Added after the
   first three, because it defeats every gate this story built. Advisory strings assembled at
   runtime (template literals, regex rewriters) told operators to run `lattice <cmd>` after
   CHK-006 deleted that bin, so the instruction failed with `MODULE_NOT_FOUND`. All four
   residue checks are structurally blind to it: they grep for STATIC literals, and this text
   does not exist as a literal anywhere. Most of the affected files were also untouched by
   this story's diff, so a diff-scoped review misses them too. Seven user-facing sites were
   found only by enumerating the class directly
   (`grep -rnE 'Run \`?lattice |Use lattice |Next: lattice |rerun lattice '`), including one
   the reviewers' own list had missed. The worst instance was `.githooks/pre-push`'s rejection
   message — the recovery instruction shown to an operator whose push was just blocked.

   **This class recurred THREE times in guards, not once.** Listed together because three
   instances is a materially stronger claim than one:

   | Finding | Guard | Consequence |
   |---|---|---|
   | F-054 | `verify-lattice-residue.mjs` `DOC_SCAN_ROOTS` | `[brand-prose]` scanned 0 of 17 prompt mirrors, reported PASS |
   | F-055 | `retired-authority-vocabulary-guard-smoke.ts` `activeTextDirs` | same, and this one is wired into the live `test:serial-reference` suite |
   | F-056 | `verify-process-fact-contract.mjs` `mirrorDirs` | worst variant: the miss only `warn()`s, so `comparePromptSemantics()` compared 0 of 17 mirrors while exiting 0 |

   F-057 is the executable sibling: `codex-adapter-checks.ts` fell back to *running* the
   deleted `lattice` bin. Note the discovery site in that same file correctly probes BOTH
   names — discovering which CLI is installed and choosing one to execute have opposite
   correctness requirements, so only the execute site changed.

   **The same blindness hit the gate itself (F-054):** `verify-lattice-residue.mjs`'s
   `DOC_SCAN_ROOTS` still listed the renamed `.lattice-codex/agents`, so
   `git ls-files -- <deleted path>` returned an empty list, that root contributed ZERO files,
   and `[brand-prose]` reported PASS while 17 live role-prompt mirrors went unscanned. A gate
   pointed at a path that no longer exists reports success on nothing. Proven fixed by planting
   a violation in a canonical mirror and observing exit 1.

   **Write paths are the higher-impact subclass (F-046, F-051, and the `.gitignore` gap).** A
   stale READ fails loudly; a stale WRITE silently recreates the directory the migration
   removed. Three separate instances appeared in this story.

5. **Self-inflicted during repair — an uncleaned test artifact committed via shared-worktree
   `git add -A` (B-cc10 F-061, plus two doc destructions and two `**/*.lock/` losses).** Not
   rename fallout at all; this class is what the *repair work itself* produced, and it did more
   damage than any single rename defect.

   A reviewer left `return false; // FAULT INJECTION` in `core/brand-paths.ts`'s
   `isStateDirPath()` while fault-injecting that function to test a witness. A `git add -A` in
   the shared worktree committed it to production source AND dist. Every consumer
   (`artifact-release.ts`, `semantic-scope-gate.ts`, `handlers/done-prepare.ts`) silently lost
   its state-dir branch: a gate that classifies nothing as a state-dir path stops protecting
   story metadata. The same commit also gutted `CLAUDE.md` 1118→12 and `AGENTS.md` 598→12
   (1,709 deletions in a commit whose message claimed `.gitignore` and one doc).

   Three properties make this class worse than the rename classes above:
   - **The blast radius is invisible in the commit message.** The stated scope and the staged
     set diverged completely, and nothing checked them against each other.
   - **HEAD-bound evidence cannot catch it.** `CHK-002`'s receipt was bound to an ANCESTOR of
     the fault commit, so it certified a function that later regressed and nothing re-ran it.
     A receipt proves only what was true at its binding.
   - **Repairs can be non-durable.** `**/*.lock/` was "restored" twice by hand INSIDE a
     generator-owned block, so `mergeLatticeRuntimeIgnores()` would have deleted it a third
     time (F-062). The durable fix was to make the registry own the pattern.

   Mitigations now applied: stage explicit paths and check the staged set against the commit's
   claimed scope; after any structural edit to a generated file, verify the WHOLE rule set
   rather than the lines you meant to touch; and prefer registry/generator ownership over
   hand-edits inside generated regions.

One case ran the other way: `red-1734-bootstrap-depfree` pinned the OLD brand string while
production correctly printed the new one — **code right, test stale.** Its regex now accepts
either brand so it survives the next rename.

### Two defects in this story's own product code, found by these tests

- `resolveSnapshotConfigFilename` (CHK-004) dropped cached probe failures for EVERY
  non-resolved config spelling, though its own comment scoped the intent to ABSENT names. An
  existing-but-unreadable config (over `MAX_LATTICE_CONFIG_BYTES`) had its oversize failure
  discarded, so the bounded-read blind spot never surfaced — the guard erased the signal it
  exists to report. Now absent-only, via `lstatSync` (not `existsSync`, which follows
  symlinks and would reintroduce the same hole).
- `.gitignore` never covered the canonical state dir at all, so every worktree showed
  `?? .proof-or-stop/` and broke every clean-tree assertion. Mirrored additively; verified
  the `!` negations still hold (7592 archives still tracked, ledgers and story indexes not
  ignored).

## Verification selectors must assert invariants, not snapshots (B-cc10 F-032/F-040)

Four verification receipts could not be re-earned after this story's own commits, because
their pinned proof selectors asserted **snapshot values** rather than invariants. All three
failure modes occurred in one story:

| Pinned selector | Why it became unmatchable |
|---|---|
| `trackedArchiveFiles=7583` | an exact COUNT; this story's own metadata commits grew it to 7593 |
| `deprecatedDirTrackedFiles=0` | became 9 when teammate story B-49ed merged in at the deprecated path — and that story must NOT be moved, so matching the pin would mean damaging someone else's work |
| `moveIsPureRenameCommit=true` | the output KEY was renamed by this story's own F-007 fix, though the property never changed |
| `**Phase**: DEV` | the story's own transient lifecycle phase, now REVIEW |

Resolution was case-by-case, not uniform:
- The renamed-key one was **re-earned mechanically**: `verify-migration-contract.mjs` now emits
  the legacy key name alongside the new one, so a receipt pinned to a cosmetic detail is not
  stranded. The property itself is re-executed and proven, not asserted.
- The other three are **audited permanent waivers** with the specific reason recorded on each,
  because their pins assert things that are now genuinely false. Matching them would require
  either lying or damaging a teammate's story.

Two witnesses gained stable invariant lines for future pins to use — `archiveFloorHeld=true`
(state-dir-migration) and `noDuplicateStateDirSpelling=true` (migration-contract) — with the
raw counts kept for diagnostics.

**Rule for future stories: a proof selector must name an invariant.** Never an exact count, a
lifecycle phase, a timestamp, or an output key that may be refactored. A selector pinned to a
snapshot converts a passing witness into an unearnable receipt.
