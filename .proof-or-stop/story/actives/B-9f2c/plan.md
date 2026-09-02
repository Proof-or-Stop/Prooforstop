# Plan: B-9f2c Migrate the graph story dossier page and add a --story deep-link flag

Upstream source of truth: `/Users/qipan/work/repo/proof-or-stop-graph` (read-only).
Migration baseline already present here: `10b5921de4b1fe5b4e796d1a7d78ec655cc400fd`.
New work to port: `4c3bde0`, `7ecad9a`, `a0b14da`, `1536588`.

Pre-staged material (do not re-derive):

- `<scratchpad>/migration/dossier.js`  — upstream `HEAD:src/shells/web/dossier.js`, verbatim
- `<scratchpad>/migration/web.patch`   — upstream diff for app.css, app.js, app.body.html, io/http.ts
- `<scratchpad>/migration/readme.patch`— upstream README diff, for reference only, applied by hand

where `<scratchpad>` is
`/private/tmp/claude-501/-Users-qipan-work-repo-Prooforstop/089dd4e2-7eda-4e1b-b570-d2c6447357aa/scratchpad`.

`app.css`, `app.js`, `app.body.html` and `io/http.ts` were confirmed byte-identical to the
upstream baseline by shasum, so `web.patch` applies cleanly. `build-web.mjs` and `README.md`
were NOT identical and are edited by hand; see the pre-mortem in decision.json.

## CHK-001: Port the dossier client sources into packages/graph

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Create: packages/graph/src/shells/web/dossier.js
- Modify: packages/graph/src/shells/web/app.css, app.js, app.body.html

**Verify**:
- `git -C . apply --check <scratchpad>/migration/web.patch` reports nothing before applying
- `diff <scratchpad>/migration/dossier.js packages/graph/src/shells/web/dossier.js` is empty
- `grep -c openStoryDossier packages/graph/src/shells/web/dossier.js` is non-zero
- `grep -n dossierSlot packages/graph/src/shells/web/app.body.html` matches
- `grep -n 'function openDossierFor' packages/graph/src/shells/web/app.js` matches
- `grep -n 'window.startPlayback\|openPlayback' packages/graph/src/shells/web/app.js` still matches (nothing pre-existing was deleted)

**DoneWhen**:
- dossier.js is present and byte-identical to the upstream file
- The web.patch hunks for app.css, app.js and app.body.html are applied
- No pre-existing app.js entry point was removed by the port

**Note**: apply `web.patch` with `git apply -p1` from the worktree root but restricted to the
three client files; `io/http.ts` belongs to CHK-002 and is applied there. If splitting the patch
is awkward, apply it whole under CHK-001 and let CHK-002 verify the http.ts hunk instead of
re-applying it — record whichever was done in the commit message.

## CHK-002: Serve the /story/<id> route and include dossier.js in the built page

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/graph/src/io/http.ts, packages/graph/scripts/build-web.mjs

**Verify**:
- `grep -n 'story' packages/graph/src/io/http.ts` shows the route regex in the app.html branch
- `grep -n "read('dossier.js')" packages/graph/scripts/build-web.mjs` matches, and appears AFTER the `read('playback.js')` line
- `grep -n 'd3 is missing' packages/graph/scripts/build-web.mjs` still matches (local change preserved)
- `npm --prefix packages/graph run build` exits 0
- `grep -c openStoryDossier packages/graph/assets/app.html` is non-zero

**DoneWhen**:
- A `/story/<id>` request is served the same app.html as `/`
- A nested `/story/a/b` path does NOT match the route
- dossier.js is concatenated last, after playback.js
- The d3 hard-failure branch is still present in build-web.mjs

## CHK-003: Add --story=<id> to the graph command with pre-listen validation

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/handlers/graph.ts, packages/main/src/cli/command-catalog.ts
- Create/Test: packages/main/src/tasks/graph-story-flag-smoke.ts (following the existing tasks/*-smoke.ts convention)

**Verify**:
- `npx tsc --noEmit -p packages/main` exits 0
- `node packages/main/dist/cli.js graph --story=B-0000zzz --no-open` exits non-zero and prints `is not a story in this repository`
- `node packages/main/dist/cli.js graph --help` shows the `--story` option
- `node packages/main/dist/tasks/graph-story-flag-smoke.js` exits 0

**DoneWhen**:
- `GraphArgs` has an optional `story` field and the catalog registers it as an optional `z.string()`, with the default documented in the description and NOT expressed via `.default()`
- With `--story=<known id>` the handler builds and reports `http://localhost:<port>/story/<encoded id>`; the id is passed through `encodeURIComponent`
- Without `--story` the reported URL is unchanged from before this story
- An unknown id throws BEFORE `startServer` is called, validated at the handler entry (not only in the Zod schema), per the repository's Handler encoding convention
- The error names near-miss candidate ids
- The check reuses `resolveStories(root).primary` from the graph library surface; no new export is added
- `--json` keeps working without requiring the browser client to be built

## CHK-004: Document the dossier and the new flag in the repository docs

**Owner**: main-agent
**DependsOn**: CHK-003
**Files**:
- Modify: packages/graph/README.md, CLAUDE.md

**Verify**:
- `grep -n -- --story CLAUDE.md packages/graph/README.md` matches in both
- `grep -n 'story/B-xxxx\|/story/<id>' packages/graph/README.md` shows the endpoint table row
- `grep -n 'How the CLI reaches this package' packages/graph/README.md` still matches
- `grep -n 'proof-or-stop-graph' packages/graph/README.md` shows no line presenting it as a runnable command

**DoneWhen**:
- The README carries the upstream dossier section and the `/story/<id>` endpoint row
- This repository's migration wording survives: header is `proof-or-stop graph`, and the `How the CLI reaches this package` section is intact
- The CLAUDE.md Story graph section lists `--story` in its flag table and mentions the dossier page

## CHK-005: Wire the new graph smoke task into the repository test surfaces

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: lattice.config.json, package.json

**Context**: `graph-command-migration.md` records this as a non-obvious trap from B-3e16 —
this repository maintains TWO separately-maintained test-surface lists, and neither is a
subset check against the other. Measured on this branch: `validate.commands` holds 116
entries, 62 of them smoke tasks registered explicitly as
`node packages/main/dist/tasks/<name>-smoke.js`; `test:serial-reference` holds 56 parts,
14 of them smoke entries registered as `npm run test:<name>-smoke`. `validate.commands`
already runs `npm --prefix packages/graph run check`, but `test:serial-reference` has NO
graph entry at all. A task added to neither list typechecks and looks wired up while
running nowhere.

**Verify**:
- `grep -n 'graph-story-flag-smoke' lattice.config.json` matches
- `grep -n 'graph-story-flag-smoke' package.json` matches in both the scripts block and `test:serial-reference`
- `npm run test:graph-story-flag-smoke` exits 0

**DoneWhen**:
- `graph-story-flag-smoke` is registered in `validate.commands` as `node packages/main/dist/tasks/graph-story-flag-smoke.js`
- `package.json` exposes an npm script alias for it
- `test:serial-reference` invokes that script
- Both surfaces reference the task; neither is left to imply the other
