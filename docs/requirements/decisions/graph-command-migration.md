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

Two test lists in this repository are separately maintained, and **neither is a subset of
the other**: `validate.commands` in the project config, and `test:serial-reference` in the
root `package.json`.

This matters here because of a trap worth naming. `validate.commands` runs
`npm --prefix packages/main run build`, **not** the root `npm run build`. Adding
`packages/graph` to the root build chain therefore does *not* cause `validate` to build or
exercise it; the subpackage needs its own explicit entries. A migration that only edited the
root chain would leave the new package silently uncovered while appearing wired up.

The same applies to `scripts/verify-lattice-residue.mjs`, whose `SRC_SCAN_ROOTS` is an
explicit list of package source roots rather than a glob, so a new package is unscanned
until it is named there.

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
