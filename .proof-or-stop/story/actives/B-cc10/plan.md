# Plan: B-cc10 Migrate the remaining lattice identities

**Execution order is NOT id order.** The dependency graph below is authoritative:

```
CHK-001 (contract, resolves the storyFilesHash unknown)
   └─> CHK-002 (read-both resolver)
          ├─> CHK-008 (rollback rehearsal)   ── must finish before ──┐
          │                                                          v
          │                                                     CHK-003 (git mv state dirs)
          ├─> CHK-004 (config + manifest filenames)
          └─> CHK-005 (npm package rename)
                          all of the above ──> CHK-006 (remove bin aliases, LAST)
                                                     └─> CHK-007 (flip residue gate)
```

Rationale for the shape: CHK-002 must land before anything moves, so the repo can operate on
either layout. CHK-008 must finish before CHK-003, so the abort path is proven before the
7580-file move. CHK-006 is last because it is the only irreversible break. CHK-007 is last-last
because it forbids the very literals the earlier items are still removing.

---

## CHK-001: Establish the migration contract and what stays frozen

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Create: `docs/requirements/decisions/proof-or-stop-identity-migration.md`

**Verify**:
- `grep -c "storyFilesHash" docs/requirements/decisions/proof-or-stop-identity-migration.md` ≥ 1
- Doc names all 6 migrated identities and all 6 excluded ones, matching `scope-boundary.json`

**DoneWhen**:
- Per identity, the doc records RENAMED-with-migration or FROZEN **plus the reason**.
- **The storyFilesHash question is ANSWERED with evidence**: does it hash file PATHS or only
  content? Read the implementation, do not infer. Record the answer and the chosen handling
  (accept drift vs add a rebind step). This is the blocking unknown from `understanding.json`.
- Doc explicitly confirms the 8 `lattice-*-integrity-v1` salts and 13 `lattice-*` role IDs are
  out of scope, citing `brand-rename-mapping.md`.
- Doc states the acceptance criterion that all 344 archives stay readable and their signatures
  still verify.
- **Doc must record TWO deliberate supersessions of prior FROZEN verdicts** (scope-plan OQ-1):
  (a) `@lattice/core` — `brand-rename-mapping.md:130` froze it because renaming would silently
  self-disarm `.githooks/pre-push`; that premise is now STALE, because B-cdf6 pre-widened the
  hook to `'@lattice/core'|'@proof-or-stop/core'`. Cite both the doc line and the widened hook.
  (b) the bin aliases — removed by CHK-006 against the mapping doc's never-remove framing.
  Both are overridden on evidence, not ignored.
- **Doc must list the 7th exclusion** (scope-plan OQ-2): the ROOT npm package name `lattice`
  (workspace `package.json`) is deliberately OUT of scope. It was not among the six identities
  the operator enumerated, `brand-rename-mapping.md:131` freezes it as a publish-level change,
  and it is verifiably publishable (no `private: true`), so renaming it is a registry-identity
  action for its own story. `scope-boundary.json` was written in INIT and is correctly immutable
  in PLAN, so this exclusion is recorded here and in the OQ-2 resolution.
- **RESOLVED empirically (was the open question). The answer is a HAZARD, and it lands on CHK-002.**
  Ran `isStoryMetadataPath` from the built `dist` against real paths:
  ```
  true    .lattice/story/actives/B-cdf6/index.json
  false   .proof-or-stop/story/actives/B-cdf6/index.json
  ```
  Archive paths are EXCLUDED from `storyFilesHash` at step 4 today — but only because the prefix
  list is derived from `PROOF_OR_STOP_STORY_DIR` = `${PROOF_OR_STOP_DIR}/story/actives`
  (`core/lattice-paths.ts:13`), whose value is still `.lattice`. After the rename, archives flip
  from excluded to INCLUDED unless that constant moves with them, and 344 archives would start
  entering the digest. The failure mode is silent: nothing errors, hashes just change meaning.
  **Consequence for the plan:** this is not a CHK-003 concern to handle after the move; it is a
  CHK-002 correctness requirement. `PROOF_OR_STOP_DIR` must be the single source the resolver owns,
  so `isStoryMetadataPath` follows the rename automatically. CHK-001 must record this finding, and
  CHK-002's acceptance must include: after the rename, `isStoryMetadataPath('<newdir>/story/...')`
  returns true. Also verify `.lattice-codex` — it returned false, so confirm whether adapter paths
  are covered by `isMaterialExcludedRuntimeArtifactPath` instead.
  (Superseded note, kept for audit: an earlier draft asserted the rename shifts the hash for all
  344 archives, citing step 5 while skipping step 4's exclusion. That framing was wrong in its
  reasoning and accidentally right about the risk — the risk is real, but it comes from a stale
  hardcoded prefix, not from paths being hashed per se.)

## CHK-002: Add a read-both path resolver before moving any file

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/src/core/lattice-paths.ts`, `packages/main/src/core/brand-env.ts`
- Modify: `packages/main/src/core/config.ts` (config filename resolution)
- Test: new smoke asserting both layouts resolve

**Verify**:
- `npm --prefix packages/main run build` exits 0 **and** `packages/main/dist/cli-engine.js` exists
  (exit code alone is not sufficient — see understanding.json fact 8)
- `node bin/proof-or-stop.js session_brief` works with `.lattice` still in place
- `grep -rn "'\.lattice'" packages/*/src --include=*.ts | grep -v dist` returns only the resolver

**DoneWhen**:
- One resolver owns state-dir, adapter-dir and config-filename resolution.
- Deprecated names resolve for READS; only canonical names are WRITTEN.
- Swept for the B-cdf6 class: no brand literal left inside a comparison, regex, allow/deny
  membership check or ownership predicate. This is where all four B-cdf6 regressions lived.

## CHK-008: Prove the state-directory move is reversible before performing it

**Owner**: main-agent
**DependsOn**: CHK-002
**Files**:
- Create: rehearsal transcript recorded as verification evidence

**Verify**:
- On a scratch clone: apply the move, run `story_get` on an archived story, `git revert` the
  move commit, run `story_get` again — both succeed
- Record the exact abort command and how to detect a half-done state

**DoneWhen**:
- Apply-then-revert demonstrated end to end on a scratch clone, not on the working worktree.
- The move is confirmed to be a **single atomic commit** so one `git revert` undoes it.
- Abort procedure written down where CHK-003's executor will see it.

## CHK-003: Migrate the on-disk state directories with history preserved

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, **CHK-008**
**Files**:
- Move: `.lattice/` → `.proof-or-stop/` (7580 tracked files, re-measure at execution time)
- Move: `.lattice-codex/` → `.proof-or-stop-codex/`
- Modify: `.gitignore`, lock paths, `.lattice-serve.json` discovery

**Verify**:
- `git mv` used throughout (never `mv` + `git add`), so history follows
- `node bin/proof-or-stop.js session_brief` and `story_get` succeed against the new path
- Signature verification passes on **two** archives from different eras, named in evidence

**DoneWhen**:
- Single atomic commit.
- Two named archives (one earliest-era, one immediately pre-migration) verify.
- Zero archive file **content** modified — history moved, never rewritten.

## CHK-004: Rename the config and manifest filenames with a read-both fallback

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Move: `lattice.config.json` → `proof-or-stop.config.json`
- Move: `.lattice-codex/lattice.json` → `.proof-or-stop-codex/proof-or-stop.json`
- Modify: config discovery, `init` writers, adapter manifest resolution

**Verify**:
- Project with only the canonical filename loads, **no notice**
- Project with only the deprecated filename loads **and** emits a one-line notice on **STDERR**
- `node bin/proof-or-stop.js validate --json` stdout still parses as a single JSON payload

**DoneWhen**:
- Canonical name is the only one written; deprecated name still read.
- Notice is stderr-only (stdout purity is a B-cdf6 hard constraint for piped consumers).

## CHK-005: Rename the npm package to @proof-or-stop/core

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: `packages/main/package.json` (the `name` field itself), `packages/utils/package.json`,
  `packages/lab/package.json`, lockfiles, ~19 source import sites
- **Root `package.json`: DEPENDENCY REFERENCES ONLY.** Its own `name` field stays `lattice` —
  that is the OQ-2 exclusion. Touch only lines that reference `@lattice/core` as a dependency,
  never the root `name`. An earlier draft of this Files list said "root package.json" without
  that qualifier, which contradicted the exclusion; corrected.

**Verify**:
- Both package builds exit 0 **and** produce dist
- `node scripts/verify-entrypoints.mjs` passes
- `grep -rn "@lattice/core" . | grep -v node_modules | grep -v dist | grep -v "^\./\.proof-or-stop"`
  returns nothing

**DoneWhen**:
- `packages/utils` (which imports `packages/main` build output) still resolves.
- Grepped for other exact-name consumers first; `.githooks/pre-push:155` already accepts both
  (verified by the INIT reviewer) but other consumers must be checked, not assumed.
- Decision recorded: deprecated alias package, or clean break.

## CHK-006: Remove the deprecated bin aliases (LAST, irreversible)

**Owner**: main-agent
**DependsOn**: CHK-002, CHK-003, CHK-004, CHK-005
**Files**:
- Delete: `bin/lattice.js`, `bin/lattice-codex.js`
- Modify: `bin/proof-or-stop-codex.js`, `verify_codex` check, `package.json` bin map,
  `.githooks/pre-push`, `CLAUDE.md`, `docs/CLI.md`, **`CHANGELOG.md`**

**Verify**:
- `node bin/lattice.js` → command-not-found
- `node bin/proof-or-stop.js --version` and `proof-or-stop codex verify` both succeed
- CHANGELOG entry names **both** removed aliases and their replacements

**DoneWhen**:
- **PLAN DECISION RECORDED HERE**: immediate removal, with the CHANGELOG entry as the
  announcement. Rationale: the operator asked for removal explicitly; the product reviewer
  judged a mandatory warn-then-remove phase disproportionate for a single-developer project
  with a tight release cadence, and set the changelog as the floor rather than optional. The
  warn-then-remove option is therefore **considered and declined**, not overlooked.
- Removal is announced, not merely performed.

## CHK-007: Extend the residue gate and re-pin affected fingerprints

**Owner**: lattice-implementer
**DependsOn**: CHK-003, CHK-004, CHK-005, CHK-006
**Files**:
- Modify: `scripts/verify-lattice-residue.mjs`
- Modify: any file holding a canonical AST fingerprint the migration moved

**Verify**:
- `node scripts/verify-lattice-residue.mjs` passes
- Reintroducing a bare `.lattice` or `@lattice/core` into `packages/*/src` makes it fail
- `node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js` and
  `node scripts/verify-process-fact-contract.mjs` both exit 0

**DoneWhen**:
- Rows for `.lattice`, `lattice.config.json`, `@lattice/core` flipped from exempt to **forbidden**
  in product runtime source; salts and role IDs stay exempt with recorded reasons.
- **Before editing any fingerprint, grep the OLD digest repo-wide** — the cli-engine.ts
  fingerprint has TWO coupled copies and updating one alone fails closed (B-cdf6 lesson).
