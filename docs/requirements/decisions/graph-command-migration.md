# Graph Command Migration

**Status**: active (B-3e16)
**Scope**: migrating the standalone story/evidence graph visualizer into this repository
as the top-level `proof-or-stop graph` command.

## Why this exists

The interactive story + evidence graph lived in a separate, untracked repository
(`@proof-or-stop/graph` 0.1.0, 32 commits, no git remote). It reads Proof-or-Stop story
state, builds a full-text index over it, and serves a browser client: a d3 graph view,
per-story detail drawer, mermaid phase-flow diagram, and timeline playback with MP4/GIF
export. Because it lived elsewhere, using it meant maintaining a second checkout, and
nothing in this repository referenced it.

The source package was written for this migration. Its README designates `src/index.ts`
as the library surface and `createApp()` / `startServer()` as the seams a CLI command
would call, and no logic depends on its own CLI shell. So the migration is a copy plus a
thin handler, not a rewrite.

This document records the four decisions that shaped the move, because each one is a
place where the obvious alternative is wrong in a way that is not obvious later.

## Decision 1: a `packages/graph` subpackage, not a merge into `packages/main`

The visualizer is 9325 lines of source, most of it a browser shell, plus roughly 4.6MB of
vendored browser bundles. Three placements were considered.

| Option | Verdict |
|---|---|
| New `packages/graph` subpackage, `packages/main` holds a thin handler | **chosen** |
| Merge directly into `packages/main` | rejected |
| Consume `@proof-or-stop/graph` as a published npm dependency | rejected |

Merging into `packages/main` was rejected for a concrete reason, not a stylistic one:
**`packages/main` ships zero static web assets today.** Its `serve` dashboard is generated
by inline template-literal functions in `packages/main/src/verifier/serve.ts`, the package
has no `files` field, and `tsc` does not copy non-TS files into `dist`. Hosting a browser
client there would mean inventing an asset pipeline and amending the build-binding hash in
`scripts/build-main-with-binding.mjs`. It would also impose the Node floor from Decision 3
on every CLI invocation rather than on one optional subcommand.

Consuming it as an npm dependency was rejected because the code would stay outside this
repository's `validate` and recursive tsc gates, and it would require the npm publication
this work explicitly excludes.

The chosen boundary is the one the source package already documents, so `packages/main`
holds only a handler that calls the exported library surface.

## Decision 2: vendored browser bundles are build output and stay out of source

`packages/graph/assets/` is gitignored. `app.html` is assembled by
`packages/graph/scripts/build-web.mjs` from the parts under `src/shells/web/`, and the
vendor bundles (d3, mermaid, gsap, mediabunny, gifenc) are copied out of `node_modules`.
Both are reproduced by `npm --prefix packages/graph run build`.

Committing them would put ~4.6MB of regenerable binaries into history and produce a large
diff on every dependency bump. The source repository made the same call, with the same
reasoning in its own `.gitignore`.

This is enforced rather than merely intended:
`npm --prefix packages/graph run verify-assets-ignored` asserts `git check-ignore` covers
the bundles and that nothing under `assets/` is tracked.

Each vendor bundle is an `optionalDependency`, and the web shell feature-detects every one,
so a missing bundle degrades a single feature instead of breaking the page.

## Decision 3: an explicit Node engines floor for `node:sqlite`

The full-text index in `packages/graph/src/core/search/fn.ts` imports `DatabaseSync` from
`node:sqlite`, which requires **Node 22.5 or newer**.

Two facts make this worth writing down. `node:sqlite` is used nowhere else in this
repository, and **no `package.json` anywhere here declared an `engines` field** before this
work. `packages/graph` is therefore the first consumer of that constraint, and it carries
`engines.node: ">=22.5.0"` alone rather than raising a floor for the whole CLI.

An unsupported runtime must produce a readable diagnostic naming `node:sqlite` and the
required version, never a raw `ERR_UNKNOWN_BUILTIN_MODULE` stack trace.

## Decision 4: the index cache lives outside the inspected repository

Proof-or-Stop gates DONE on a clean worktree. A visualizer that wrote into the tree it
reads would sabotage the lifecycle it exists to display.

The SQLite index therefore lives under the user cache directory, in a subdirectory keyed by
a sha256 of the inspected repository root, and each build writes to a pid-suffixed temp file
that is atomically renamed into place, so concurrent processes never read a half-populated
FTS table.

A consequence worth stating explicitly: **the graph command needs no
`runtime-artifact-registry` entry.** `serve` needs one because it writes a discovery file
into the project, which would otherwise perturb the material hash that signed evidence is
bound to. The graph command writes no such file.

Both halves are mechanically checked:

- `npm --prefix packages/graph run verify-clean-tree` runs a real full scan (graph build,
  index build, story serialisation, search) and asserts the resolved index path is outside
  the repository and that `git status --porcelain` is byte-identical across the run. It
  compares a delta rather than asserting absolute cleanliness, so it stays honest when
  unrelated CLI metadata writes are already present.
- `npm --prefix packages/graph run verify-no-project-writes` enumerates every filesystem
  write call in the served runtime source and asserts each targets the cache directory. It
  fails if a new write path appears without the registry question being revisited.

Each check was confirmed to have real discriminating power by negative control before being
relied on: removing the ignore rule, pointing the cache inside the repository, and injecting
a simulated discovery-file write each made the corresponding check fail.

## Test-surface placement

**Three** membership authorities in this repository are separately maintained, and **none is
a subset of another**:

1. `validate.commands` in the project config.
2. `test:serial-reference` in the root `package.json` (plus the `test:<name>` script it names).
3. `RESOURCE_POLICY` in `packages/main/src/tasks/full-suite-runner.ts`.

The third is the easiest to miss and the most punishing to omit. `entriesFromSerialReference`
**fails closed**: a `test:serial-reference` member with no `RESOURCE_POLICY` entry aborts the
**entire root test suite** with `canonical inventory mismatch unknownPolicy=[…]`, rather than
merely skipping that member. So forgetting it does not under-test one task — it takes down
`npm test` for the whole repository.

This has now bitten three stories: B-cdf6 and B-49ed (recorded in the comments beside their
own entries in that file), and B-9f2c, whose CHK-005 modelled its plan on the earlier
**two**-list wording of this very section and consequently registered its new smoke task in
lists 1 and 2 only. `npm test` then exited 1 in 858ms and blocked `done_required_validate`.
Registering a new test task means editing all three lists, not two.

This matters here because of a trap worth naming. `validate.commands` runs
`npm --prefix packages/main run build`, **not** the root `npm run build`. Adding
`packages/graph` to the root build chain therefore does *not* cause `validate` to build or
exercise it; the subpackage needs its own explicit entries. A migration that only edited the
root chain would leave the new package silently uncovered while appearing wired up.

The same applies to `scripts/verify-proof-or-stop-residue.mjs`, whose `SRC_SCAN_ROOTS` is an
explicit list of package source roots rather than a glob, so a new package is unscanned
until it is named there.

## Decision 5: the runtime dynamic import is permanent, and why

`packages/main/src/handlers/graph.ts` reaches this package through a runtime
`await import(...)` rather than a static `import`. The README and the handler's own header
give one reason — this repository declares no npm workspaces and `packages/graph` is not a
dependency of `packages/main`. **That reason is removable, and it is not the binding one.**
Someone could add the dependency, convert to a static import, and believe they had tidied
things up.

The binding reason is the Node floor from Decision 3. `packages/graph/src/core/app.ts`
statically imports `./search/fn.js`, which top-level imports `node:sqlite`, and the handler
cannot avoid `createApp`. ESM static imports are hoisted and evaluated eagerly, so a static
import would pull `node:sqlite` into `packages/main`'s always-evaluated module graph — and
that graph is evaluated for **every** CLI command, not just `graph`.

Verified on a real Node v20.19.6, not reasoned about:

| probe | result |
|---|---|
| `import('packages/graph/dist/index.js')` | `ERR_UNKNOWN_BUILTIN_MODULE` |
| `import('packages/graph/dist/core/app.js')` | `ERR_UNKNOWN_BUILTIN_MODULE` |
| `proof-or-stop --version` (today, dynamic import) | works |
| a real read-only command (today) | works |

So the CLI is usable on Node 20 today *because* the import is dynamic. Converting it would
turn a feature that degrades gracefully on old runtimes into a CLI that cannot start at all.
Reorganising `packages/graph/src/index.ts` would not help either: the chain runs through
`core/app.ts`, which any consumer of `createApp` must load.

The cost of keeping it is that the loader trips
`retired-authority-vocabulary-guard-smoke`'s ban on non-literal dynamic module loads, so
`handlers/graph.ts` carries an approval entry in that guard. The approval records that the
resolved path is `--root`-influenceable and that this matches the trust model already
accepted there for `verifier/serve.ts`'s `startCircuitServe`. See the comment on the entry
itself for the full reasoning.

## The registration surface set is discovered by gate, not fixed

Registering a new top-level command touches a set of fail-closed surfaces. Scoping for
this work enumerated eight; a ninth — `packages/main/src/core/process-fact-levels.ts` —
only surfaced when `test:process-fact-contract` failed after the other eight were done.

Treat that number as a lower bound, not a checklist. The authoritative answer is what the
contract tasks say: `command-ownership-contract`, `command-catalog-smoke`,
`cli-surface-smoke`, `verify-orphan-surface`, `lifecycle-registry-contract` and
`test:process-fact-contract` each assert a different registration invariant, and several
derive their expectations rather than listing them: `COMMAND_PROCESS_FACTS` is computed
from `PROCESS_FACT_LEVELS` and `COMMAND_POLICIES`, so a single missing entry there fails
three distinct assertion sites in `scripts/verify-process-fact-contract.mjs` — one
missing-from-`PROCESS_FACT_LEVELS`, one missing-from-`PROCESS_FACT_REGISTRY`, and one
phase-allowlist-drift complaint per phase in `ALL_PHASES`. Recompute the total from
`ALL_PHASES.length + 2` rather than trusting a figure typed here; an earlier draft of this
paragraph stated a hand-counted number and it was wrong. Run them all and fix what they
report; do not assume a fixed count is complete.

Note the six tasks run through the **three separately-maintained membership authorities**
the "Test-surface placement" section above describes: most are entries in
`validate.commands`, while `test:process-fact-contract` is reached through the root
`test:serial-reference` list *and* carries the `RESOURCE_POLICY` entry that membership
requires (`repoRead('test:process-fact-contract')` in `full-suite-runner.ts`). No list is
derived from another, so a task can be in one, some, or none of them — and a
`test:serial-reference` member missing its `RESOURCE_POLICY` entry aborts the whole root
suite rather than being skipped.

## Terminology

**Recursive tsc gate** — both `proof-or-stop validate --lint` and `.githooks/pre-push`
recursively discover every `tsconfig.json` in the repository (excluding `node_modules`,
`dist`, `build`, `.worktrees`, `.git`) and run `tsc --noEmit` on each. Adding a package with
its own `tsconfig.json` therefore opts it into that gate automatically, which is why
`packages/graph` must compile clean from the moment it lands.

## What this does not cover

The migration deliberately changed no behavior. The web shell was not rewritten, and the
graph rendering, full-text search, and timeline playback and export features behave exactly
as they did in the source repository. The source repository was not deleted or modified, and
`@proof-or-stop/graph` is not published to the npm registry — the package is marked
`private`.
