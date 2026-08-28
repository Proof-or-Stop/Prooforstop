# @proof-or-stop/graph

Interactive 3D story + evidence graph for Proof-or-Stop repositories.

```bash
cd /path/to/a/proof-or-stop/repo
proof-or-stop graph
```

Collects every story, builds a full-text index, serves the graph, opens the browser.

This package has no binary of its own: it is the library behind the `proof-or-stop graph`
command, whose handler lives in `packages/main/src/handlers/graph.ts` and reaches this
package through `dist/index.js`.

## Options

| Flag | Meaning |
|---|---|
| `--root=<dir>` | Repository to read (default: nearest Proof-or-Stop root from cwd) |
| `--port=<n>` | HTTP port (default 8731) |
| `--no-open` | Do not launch a browser |
| `--json` | Print status as JSON and exit |

## What it reads

Story state comes from `.proof-or-stop/story/actives` and `.lattice/story/actives`.

**Worktree precedence is load-bearing.** From PLAN onward a story's live artifacts live
in its linked git worktree; the main checkout keeps only the INIT_CHECK snapshot. Reading
the main checkout alone reports every in-flight story as INIT_CHECK with ~2 events.

Nothing is written into the inspected repository — Proof-or-Stop gates DONE on a clean
worktree, so the index cache lives under `~/.cache/proof-or-stop-graph/`.

## Architecture

Core/Shell, matching the Proof-or-Stop convention: shells never contain logic.

```
src/
  core/
    data.ts            types only
    machine.ts         pure configuration
    app.ts             assembly: caching + rebuild policy
    store/fn.ts        story resolution, worktree precedence, change signatures
    graph/fn.ts        nodes, directed edges, transitive depth
    detail/fn.ts       full-fidelity single-story read (no truncation)
    search/fn.ts       SQLite FTS5 index + query
  io/
    http.ts            routes only
    open-browser.ts    best-effort browser launch
    find-root.ts       repository discovery
  shells/
    cli/main.ts        standalone entry, retained from the pre-migration package
                       (unused here -- `proof-or-stop graph` is the entrypoint)
    web/                browser client, assembled into assets/app.html by
      app.head.html     scripts/build-web.mjs -- edit these, never the asset
      app.css
      app.body.html
      graph2d.js        d3 graph view
      app.js            drawer, tabs, search, phase-flow diagram
      playback.js       timeline playback viewer + MP4/GIF export
```

### Two change signatures

`owner-lease.json` and friends are rewritten every few seconds. Including them in the
index signature rebuilt all ~23k rows continuously, adding seconds to every request.

- `contentHash` — searchable content; gates the expensive index rebuild
- `liveHash` — heartbeat files only; gates the cheap graph refresh (~150–550ms)

### Directed edges

`depends` alone covers ~35 of 367 stories, which would leave the graph almost entirely
disconnected. Prose references (`B-xxxx` in index/understanding/decision/background/plan)
recover the rest; direction is chronological, so a newer story referencing an older one
builds on it. Edge kind is preserved (`dep` vs `ref`) and rendered differently.

## Light and dark

The page follows the OS colour scheme by default; the sun/moon button beside the
search field pins it either way, and the choice is remembered in `localStorage`.

There is one palette. Every colour lives in CSS custom properties on `:root`
(`--bg`, `--ink*`, `--acc`, the `--ph-*` phase hues, and `--g-*` for the graph
layer), and the surfaces that cannot read CSS directly — the 2D canvas painter,
the d3/SVG graph, and Mermaid, which bakes its theme in at `initialize()` — read
those same properties and are repainted on a switch.

## Timeline playback

The **Playback** button on a story's Timeline tab — beside the phase-flow diagram, and
again above the lifecycle list — opens a full-window player: the
lifecycle drawn as a flowchart and animated one recorded transition at a time, with
MP4 (1920×1080) and GIF (1440×810) export.

The animated diagram is built per transition -- one node per phase, one labelled arrow
per recorded transition, in `segments[].index` order -- rather than from the aggregated
phase-flow diagram on the same tab, which collapses repeat transitions (`4x back`) and so
has no per-event ordering to animate. Backward transitions are dotted.

It consumes exactly the JSON the tab's **Export JSON** button writes, and validates it on
the way in, so the animation and the downloadable file cannot drift apart. Clip length,
pacing (even, or proportional to how long each phase was actually held), frame rate and
H.264 quality are under **Settings**.

Encoding runs in the tab: Canvas draws each frame from a geometry snapshot taken once,
WebCodecs encodes across several parallel lanes, and the finished MP4 is verified for
duration, exact frame count and readable pixels before it downloads. Export needs Chrome
or Edge; the viewer itself works anywhere Mermaid does.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/graph` | nodes + directed edges + signatures |
| `GET /api/story?id=B-xxxx` | every file for one story, verbatim |
| `GET /api/search?q=…` | FTS hits, stories ranked above their own artifacts |
| `GET /api/status` | counts, signatures, index metadata |

Two files (`prompt-envelopes.json`, `review-runs.json`) are ~96% of story bytes and hold
only digests; they are returned as a summary (count + keys + sample) rather than in full.

## How the CLI reaches this package

`src/index.ts` is the library surface. `createApp()` and `startServer()` are the seams the
`proof-or-stop graph` command calls; nothing outside this package depends on its own shell.

The migration into Proof-or-Stop is complete (B-3e16). Because this repository declares no
npm workspaces and `packages/graph` is not a dependency of `packages/main`, the handler
resolves this package at RUNTIME rather than importing it statically -- see
`resolveGraphPackage()` in `packages/main/src/handlers/graph.ts`. Design decisions are
recorded in `docs/requirements/decisions/graph-command-migration.md`.

## Development

```bash
npm install
npm run build        # tsc + assemble assets/app.html + vendor d3, mermaid, gsap,
                     #   mediabunny and gifenc into assets/
npm run check        # build + typecheck + the verify-* guards + audit + bench
```

Run the command itself from the repository root with `proof-or-stop graph`; this package
has no `start` script, because it is a library rather than a standalone tool.

Requires Node >= 22.5 (`node:sqlite`, used by the full-text index).
