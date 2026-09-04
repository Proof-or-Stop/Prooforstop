# Plan: B-3e16 Migrate the proof-or-stop-graph story visualizer into this repo as the proof-or-stop graph command

Chosen option: **A — new packages/graph subpackage**, with packages/main holding only a thin
handler that calls the library surface the source package already exports (`createApp`,
`startServer`). Pure migration: source is copied verbatim, not rewritten.

Source of truth for what is in and out of scope: `scope-boundary.json` (7 allowed, 6 excluded).

## CHK-001: Stand up packages/graph as a workspace subpackage with its own build

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Create: packages/graph/package.json, packages/graph/tsconfig.json, packages/graph/.gitignore
- Create: packages/graph/src/** (copied verbatim from ~/work/repo/proof-or-stop-graph/src)
- Create: packages/graph/scripts/build-web.mjs, packages/graph/scripts/copy-assets.mjs
- Modify: package.json (root build chain)

**Notes**:
- This repo has **no npm workspaces** (root package.json has no `workspaces` field, and there is
  no node_modules/@proof-or-stop link tree). Cross-package builds are explicit
  `npm --prefix <pkg> run build` calls chained in the root `build` script. Add the graph build
  as a new chain entry; do NOT add a workspaces field.
- Root build script today: `npm --prefix packages/main run build && npm --prefix packages/utils run build && node scripts/verify-full-suite-build-binding.mjs`.
- Copy the source `.gitignore` so `assets/` stays ignored. Verify with `git check-ignore`.
- Declare `d3` + `zod` as dependencies; `mermaid`, `gsap`, `mediabunny`, `gifenc` as
  optionalDependencies (the web shell feature-detects each one).

**Verify**:
- `npm --prefix packages/graph run build` prints `assets: app.html` and `assets: d3.min.js`
- `packages/graph/dist/index.js` exists
- `npx tsc --noEmit -p packages/graph` exits 0
- `git check-ignore packages/graph/assets/app.html` exits 0

**DoneWhen**:
- packages/graph compiles clean under the recursive tsc gate
- the root build script builds graph as well as main and utils
- no file under packages/graph/assets is tracked by git

## CHK-002: Declare the Node engines floor that node:sqlite requires

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/graph/package.json (engines.node)
- Modify: packages/main/src/handlers/graph.ts (readable failure on an old runtime)

**Notes**:
- `packages/graph/src/core/search/fn.ts` imports `DatabaseSync` from `node:sqlite`, which needs
  Node >= 22.5. `node:sqlite` is used nowhere else in this repo, and **no package.json anywhere
  here declares an engines field**, so this subpackage is the first consumer of that constraint.
- The failure mode to avoid is an unhandled `ERR_UNKNOWN_BUILTIN_MODULE` stack trace.

**Verify**:
- `node -e "console.log(require('./packages/graph/package.json').engines.node)"` prints `>=22.5.0`
- A simulated old-runtime path prints a message naming node:sqlite and the required version

**DoneWhen**:
- engines.node is declared as >=22.5.0
- an unsupported runtime produces a readable one-line diagnostic, not a stack trace

## CHK-003: Register graph across all eight command-surface touchpoints

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/handlers/graph.ts
- Modify: packages/main/src/cli/command-catalog.ts (MAIN_TOOLS entry)
- Modify: packages/main/src/core/command-policy.ts (COMMAND_POLICIES row)
- Modify: packages/main/src/registry.ts (registerBatch)
- Modify: packages/main/src/cli-engine.ts (process-fact mirror comment, lines 194-440)
- Modify: packages/main/src/core/config.ts (DEFAULT_PHASE_TOOLS)
- Modify: packages/main/src/cli/activity-policy.ts (READ_ONLY_COMMANDS)
- Modify: packages/main/src/cli/help-renderer.ts (KNOWN_GROUP, KNOWN_ORDER)

**Notes**:
- All eight are fail-closed; a partial registration either fails a contract test or produces a
  command that `help` lists but dispatch cannot find. Treat as one atomic item.
- ownershipClass is **readOnly**, destructiveRisk **none**: the command reads story state and
  writes its index cache outside the repository.
- `command-ownership-contract.ts:90-95` defines `STANDALONE_COMMANDS = new Set(['dashboard'])`,
  the single dispatchability exemption — relevant to CHK-004's dispatch shape.
- Help groups derive from the prefix before the first `_`; a bare `graph` has none, so it needs
  explicit KNOWN_GROUP / KNOWN_ORDER placement.
- Schema flags, matching what the source CLI already parses: `root` (string, optional),
  `port` (number, optional), `open` (boolean, optional, default true), `json` (boolean, optional).

**Verify**:
- `node bin/proof-or-stop.js help` lists graph
- `node bin/proof-or-stop.js graph --help` prints the four flags
- `npm run test:command-ownership-contract` passes
- `npm run test:orphan-surface` passes

**DoneWhen**:
- all eight surfaces carry the command
- command-ownership-contract, command-catalog-smoke, cli-surface-smoke and orphan-surface all pass

## CHK-004: Serve the browser client from packages/graph so the long-running command works end to end

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: packages/main/src/handlers/graph.ts
- Modify: packages/main/src/cli-engine.ts (long-running dispatch, if the dashboard branch shape is used)

**Notes**:
- packages/main ships **zero** static web assets (its serve dashboard is an inline template
  literal in packages/main/src/verifier/serve.ts), has no `files` field, and tsc does not copy
  non-TS files into dist. The browser client must therefore be served out of packages/graph.
- Resolve the packages/graph root robustly (`createRequire(import.meta.url).resolve` of the
  package entry), not by a relative `__dirname` walk that breaks under a global install.
  Fail with an explicit message naming the missing asset dir and the build command.
- Hand `startServer` the `assetDir` and `vendorDir` the source CLI already passes.
- `graph` is long-running, same shape as `dashboard` (pre-dispatch branch near cli-engine.ts:818
  via dynamic import, and the sole dispatchability exemption). Follow that precedent.
- Preserve source behavior exactly: default port 8731, repo discovery from cwd when `root` is
  absent, `--json` prints status and exits without serving, `--no-open` suppresses the browser,
  and SIGINT/SIGTERM shut down both server and app.

**Verify**:
- `node bin/proof-or-stop.js graph --no-open` prints counts then a `http://localhost:8731/` URL
- `curl -s localhost:8731/ | head -c 200` returns the HTML document
- `curl -s localhost:8731/api/graph` returns JSON with nodes and edges
- `node bin/proof-or-stop.js graph --json` prints status JSON and exits 0 without listening

**DoneWhen**:
- the page loads with a working graph, search and story drawer
- all four source flags behave as they do in the source repo

## CHK-005: Keep the index cache out of the inspected repository and off the runtime-artifact surface

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-004
**Files**:
- Modify: packages/graph/src/core/app.ts (only if the property does not survive the move)

**Notes**:
- Proof-or-Stop gates DONE on a clean worktree, so the tool must never dirty the tree it inspects.
- The source already places the index under the user cache dir keyed by a sha256 of the repo root,
  and builds to a pid-suffixed temp file atomically renamed into place, so concurrent processes
  never read a half-populated FTS table. Verify the property **survives the move** rather than
  re-implementing it.
- Confirm nothing needs a runtime-artifact-registry entry: unlike `.lattice-serve.json` (registered
  in packages/main/src/core/runtime-artifact-registry.ts), graph writes no discovery file into
  the project.

**Verify**:
- `git status --porcelain` byte-identical before and after running the command in a worktree
- the index db path is under the user cache dir, not under the repo

**DoneWhen**:
- running graph inside a story worktree leaves git status unchanged
- no new runtime-artifact-registry entry is required, and that is confirmed rather than assumed

## CHK-006: Carry over the source repo's own checks and document the command

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005
**Files**:
- Modify: packages/graph/package.json (check scripts)
- Modify: CLAUDE.md
- Create: docs/requirements/decisions/graph-command-migration.md

**Notes**:
- The source ships three self-checks that would otherwise be lost: `src/tasks/anchor-check.mjs`,
  `src/tasks/audit.ts`, `src/tasks/bench.ts`, run together by its `check` script.
- Decide **explicitly** which belong in the repo test surface. Note that the project config's
  `validate.commands` and the root package.json `test:serial-reference` list are separately
  maintained and neither is a subset of the other (dev-memory c84e0c8).
- Document: a CLAUDE.md section for the command and its flags, plus a decisions entry recording
  the four migration decisions (subpackage boundary, assets as gitignored build output, the
  node:sqlite engines floor, dashboard-style long-running dispatch).
- Also fold in the INIT reviewer's low advisory INIT-001: give "recursive tsc gate" an inline
  one-clause definition where the docs use it.
- Nothing in this repo references proof-or-stop-graph outside one runtime log line, so this is
  net-new documentation, not an edit of existing claims.

**Verify**:
- `npm --prefix packages/graph run check` passes
- `grep -n "proof-or-stop graph" CLAUDE.md` returns the new section
- `docs/requirements/decisions/graph-command-migration.md` exists and covers all four decisions

**DoneWhen**:
- the three source self-checks run as packages/graph npm scripts
- CLAUDE.md and the decisions doc both describe the command and its flags
- the placement decision for the repo test surface is written down, not left implicit
