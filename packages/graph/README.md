# @proof-or-stop/graph

Interactive 3D story + evidence graph for Proof-or-Stop repositories.

```bash
cd /path/to/a/proof-or-stop/repo
proof-or-stop graph
```

Collects every story, builds a full-text index, serves the graph on the local loopback
interface, and opens the browser.

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

Story state comes only from `.proof-or-stop/story/actives`; retired state roots
are not normal discovery fallbacks.

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
    web/                browser client, assembled into assets/app.html by
      app.head.html     scripts/build-web.mjs -- edit these, never the asset
      app.css
      app.body.html
      graph2d.js        d3 graph view
      app.js            drawer, tabs, search, phase-flow diagram
      playback.js       timeline playback viewer + MP4/GIF export
      dossier.js        full-window per-story dossier page
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

## Story dossier

The **open dossier** button in the drawer header opens a full-window page for the
selected story. Opening runs a fast sweep from T+0 so the reader watches the story
assemble, then lands on the full current state; pressing Play replays the recorded
history at a chosen pace, every panel advancing together on one shared time cursor.
The sweep is skipped under a reduced-motion preference.

The page then keeps itself current: it re-polls `/api/story` while open (4s in flight,
15s finished). New findings land with a burst ring on the map, a highlighted line in the
wire log, a counter bump and a toast; a phase change or a story reaching DONE is
announced the same way.

The dossier has its own URL: opening it pushes `/story/B-xxxx` (served by the same server
as `/`, which stays the graph), so a dossier can be opened directly by path, shared, and
driven with the browser's back/forward buttons; closing it returns to `/` with the graph
and drawer intact. From the command line, `proof-or-stop graph --story=B-xxxx` opens that
page directly — see the root `CLAUDE.md` for the flag table.

- **The map** — one dot per finding, packed into labelled hulls by a selectable dimension
  (reviewer lane, root-cause cluster, category, severity, file). Dot size is severity,
  faded dots are settled, hollow dots are dismissed. The layout is deterministic (greedy
  circle packing + phyllotaxis), so it needs no d3 and never jitters.
- **The loop** — the seven-phase lifecycle with visit counts, held time and dotted red
  arcs for backward bounces.
- **The web** — the story's ego-graph: what it builds on and who builds on it, declared
  dependencies solid and prose references faded, each neighbour a click away.
- **Checklist / Outcome** — a segmented progress track beside a big count, and the
  acceptance verdict as a stamp-like seal next to metric tiles for evidence, DONE-gate
  receipts, review passes and validation.
- **Findings feed** — every finding in one chronological list, newest first, each row
  expanding in place to the full text, resolution and files.
- **Origin & Decision / Signals & Ledger** — the decision drawn as a fork (chosen option
  highlighted, the rest ghosted), pre-mortem markers and keyword chips, with metric tiles
  for bugs, milestones, takeovers, red evidence and gate failures.
- **The swarm** — one cell per recorded dispatch, coloured by agent type.
- **Pulse** — findings opened vs settled over story time, phase bands behind.
- **Wire log** — the process-event stream, one line per event.

Everything is derived client-side from the raw `/api/story` detail (`findings.json`,
`process-events.jsonl`, `index.json`, `clusters.json`, `checklist.json`) — seeded from the
drawer's already-fetched copy, then refreshed by the dossier's own polling. Colours are
read as CSS custom properties at paint time, so the dossier follows the light/dark toggle
with no repaint hook. Lane labels shorten canonical `proof-or-stop-review-`
and `proof-or-stop-` prefixes. Historical labels are shown without rewriting
them into current role identities.

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
| `GET /story/B-xxxx` | the same shell; the client opens that story's dossier over the graph |
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
npm run check        # one typechecked build + the verify-* guards + audit + bench
```

Run the command itself from the repository root with `proof-or-stop graph`; this package
has no `start` script, because it is a library rather than a standalone tool.

Requires Node >= 22.5 (`node:sqlite`, used by the full-text index).
