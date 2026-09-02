# Plan: B-41c8 Extract one owner each for the rename-aware diff reader, the legacy command parse, and story workspace resolution, plus a call-site audit

All Proof-or-Stop commands in this story run from the worktree `.worktrees/B-41c8` with the worktree's own build: `node packages/main/dist/cli.js`. The global `proof-or-stop` binary is a stale build in another story's worktree. Rebuild with `npm --prefix packages/main run build` after every source change before running any evidence command.

Every behaviour change lands RED first: the fixture case is committed failing (a commit whose subject starts `RED:`), then the implementation commit turns it green (`GREEN:`). The single smoke file `packages/main/src/tasks/single-owner-extraction-smoke.ts` holds all cases for CHK-001 to CHK-004 and prints one line per case, ending `single-owner-extraction-smoke: PASS` or `single-owner-extraction-smoke: FAIL`.

Recorded observation during this PLAN (2026-09-02): running `understanding_set` and `decision_set` for B-41c8 with the shell cwd in the main checkout wrote `understanding.json` and `decision.json` into the main checkout's `.proof-or-stop/story/actives/B-41c8/` (seen as untracked there by `git status --short`), not into the story worktree; the files were removed and the commands re-run from the worktree. Neither handler calls `resolveGitCwd`, so this is outside CHK-004's audit universe and is recorded here as a measured example for the follow-up migration draft `migrate-resolvegitcwd-callers-to-workspace`, not as scope of this story.

## CHK-001: Make the rename-aware diff reader parse NUL-delimited output and fail loudly on unparseable rows

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/evidence-freshness.ts
- Create: packages/main/src/tasks/single-owner-extraction-smoke.ts
- Test: packages/main/src/tasks/single-owner-extraction-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/single-owner-extraction-smoke.js` ends `single-owner-extraction-smoke: PASS`
- RED commit shows the quoted-rename case failing with the C-quoted string in the reported path set; GREEN commit shows both plain paths

**DoneWhen**:
- `changedFilesBetweenRenameAware`, `changedFileStatusesBetweenRenameAware` and `changedStoryFilesBetween` invoke `git diff --name-status -M -z` and parse NUL-separated records (status, then one path, or two paths for R/C statuses)
- A record that does not fit that shape throws an Error whose message contains the raw record; no row is skipped
- A fixture repository built in a temp dir renames `a b.txt`, a file whose name is two Japanese-script characters (non-ASCII, so git C-quotes it), and `q"uote.txt`; all three renames report both sides through both reader functions
- Deleted paths still appear; copies report both sides
- `materialHash` and `storyFilesHash` over a fixture repository with only plain paths are byte-identical before and after the change (the fixture keeps the old tab parser as a local reference implementation for the comparison)
- The unresolvable-ref contract is unchanged (still throws) and a case greps `packages/main/src` for `catch` blocks that return `[]` around these three functions and asserts none exist

## CHK-002: Route done-required-validation's command-string parse through the canonical parser

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/done-required-validation.ts
- Test: packages/main/src/tasks/single-owner-extraction-smoke.ts

**Verify**:
- `grep -n "splitShellWords\|SHELL_META_RE\|commandFromString" packages/main/src/core/done-required-validation.ts` prints nothing
- `node packages/main/dist/tasks/single-owner-extraction-smoke.js` ends `single-owner-extraction-smoke: PASS`

**DoneWhen**:
- RED commit adds a corpus case: a committed array of tricky command strings (metacharacters, single- and double-quoted arguments with embedded spaces, escaped quote, empty string, leading/trailing whitespace) fed through the private parser (temporarily exported for the RED commit) and through `parseLegacyValidationCommandString`; the case fails on any disagreement. If the corpus finds a disagreement, the implementer names it in the RED commit body and resolves it in GREEN by an explicit named function with its own case, never by silent tolerance
- GREEN commit deletes the private parser and the temporary export; `done-required-validation.ts` imports `parseLegacyValidationCommandString`
- A case asserts that the DONE-required executor and `handlers/verifier.ts` produce the same `{shell, command, args}` for every corpus entry

## CHK-003: Extract one shared story-workspace resolver and migrate the four existing implementations onto it

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/core/story-workspace.ts
- Modify: packages/main/src/handlers/story-query.ts, packages/main/src/handlers/session.ts, packages/main/src/core/local-assurance-story-projection.ts, packages/main/src/handlers/validation-plan.ts
- Test: packages/main/src/tasks/single-owner-extraction-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/single-owner-extraction-smoke.js` ends `single-owner-extraction-smoke: PASS`
- `node packages/main/dist/cli.js validation_plan --storyId=B-41c8 --tier=fast --json` from the worktree and from the main checkout print the same `selectionDigest`

**DoneWhen**:
- `core/story-workspace.ts` exports one function that, given ctx and a storyId, returns `{ gitCwd, store, config, source }` where gitCwd comes from `resolveGitCwd`, the store is rooted at the resolved workspace, config is loaded from that workspace, and `source` says whether a linked worktree or the invocation root was used
- The phase-terminal guard (`DONE` / `DISCARDED` never read from a linked worktree) is an option; its default is applied per caller to match that caller's current behaviour, and a case per migrated caller asserts DONE-story reads are unchanged
- The state-directory path is derived through `core/brand-paths.ts`; a case greps the new file for the retired literal state-dir spelling and asserts zero hits
- `readStoryProjection`, `listActiveWorktrees` / `readStoryFromLinkedWorktree`, `collectLinkedStoryWorktrees` and `resolveStoryWorkspace` delegate to the helper; their own resolution logic is removed
- A wrapper-root fixture (`gitRoot` configured below the invocation root) resolves the story worktree through the helper

## CHK-004: Add a committed audit fixture that enumerates resolveGitCwd call sites and classifies their store and config reads

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: package.json, packages/main/src/tasks/full-suite-runner.ts, proof-or-stop.config.json
- Test: packages/main/src/tasks/single-owner-extraction-smoke.ts

**Verify**:
- `npm run test:single-owner-extraction` ends `single-owner-extraction-smoke: PASS` and prints a block headed `resolveGitCwd call sites`
- `grep -n single-owner-extraction package.json packages/main/src/tasks/full-suite-runner.ts proof-or-stop.config.json` shows the suite in `test:serial-reference`, `RESOURCE_POLICY` and `validate.commands`

**DoneWhen**:
- The audit scans `packages/main/src/handlers/*.ts` for `resolveGitCwd(` call expressions, ignoring occurrences inside `//` and `/* */` comments and inside string literals, and resolving import aliases (`import { resolveGitCwd as x }`)
- For each real caller it reports `workspace-rooted` when every StoryStore construction and config load in that file goes through the CHK-003 helper, otherwise `reads ctx.root: <story|checklist|config>` listing which reads remain
- validate-channel.ts is reported under `comment-only mentions`; review-preflight.ts is reported as a real caller; a temporary aliased-import fixture file is detected as a caller and cleaned up
- The RED commit shows the flagged list non-empty; the story does not attempt to empty it — the printed list is the input to draft `migrate-resolvegitcwd-callers-to-workspace`
- The suite is registered in the three inventories and a case reads those real files to assert it
