import { readManagedRunDashboard, type ManagedRunDashboard } from '../core/managed-run-dashboard.js';
/**
 * @task B-3e16
 * @checklist CHK-003, CHK-004
 * @title register the graph command and serve its browser client
 * @type feature
 * @priority high
 * @description
 *   B-3e16 CHK-003: `proof-or-stop graph` is the CLI entrypoint for the story +
 *   evidence graph visualizer that lives in the `packages/graph` subpackage.
 *
 *   DISPATCH SHAPE — this is a NORMAL registered handler, not a `dashboard`-style
 *   standalone pre-dispatch branch in `cli-engine.ts`. `dashboard` is the single
 *   command exempted from the dispatchability assertion in
 *   `tasks/command-ownership-contract.ts` (`STANDALONE_COMMANDS`), and widening
 *   that exemption would weaken a real contract. The precedent that settles it is
 *   `serve` (`handlers/verifier.ts`): also long-running, also a normal registered
 *   handler, and it simply returns a Promise that stays pending for the lifetime
 *   of the served process. `graph` follows `serve`, so the dispatchability
 *   assertion keeps covering every catalog command with no new exemption.
 *
 *   MODULE RESOLUTION — this repo has no npm workspaces and `packages/graph` is
 *   not a dependency of `packages/main`, so `@proof-or-stop/graph` cannot be
 *   imported statically (tsc would not resolve it, and `rootDir: src` forbids
 *   compiling files from outside this package). The graph library is therefore
 *   reached at RUNTIME through `resolveGraphPackage()` below, which is also the
 *   seam CHK-004 needs in order to locate `assets/` and `node_modules/` for the
 *   browser client.
 *
 *   SCOPE — CHK-003 registered the command and reported resolved status.
 *   CHK-004 makes it actually serve: it starts the graph package's HTTP server,
 *   opens the browser unless suppressed, and stays in the foreground until the
 *   process is interrupted.
 *
 *   WATCHDOG — the CLI wraps every command in an idle/max watchdog
 *   (`cli-engine.ts`): five minutes with no log output, or fifteen minutes
 *   total, and a non-structured command is killed via `process.exit(2)`.
 *   `serve` inherits the same bound. So that a browsing session does not die at
 *   the idle mark, this handler emits a periodic heartbeat through `ctx.log`,
 *   which writes to stderr and is what resets the watchdog's activity clock.
 *   The absolute bound is CLI-wide and not ours to relax here; it is raised per
 *   invocation with `PROOF_OR_STOP_MAX_TIMEOUT_MS`, and the served output says so.
 * @changes
 *   - [CHK-003] Add the graph handler behind the runtime package resolution seam.
 *   - [CHK-004] Serve the browser client: startServer + openBrowser + signal
 *     shutdown, with a watchdog heartbeat so a session survives idle periods.
 *   - [B-9f2c CHK-003] Add --story=<id>, which deep-links the served URL to that
 *     story's dossier page. An unknown id is refused BEFORE the server listens,
 *     naming near-miss candidates, and the id is URL-encoded into the path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { HandlerContext } from './context.js';

/**
 * Bring the graph subpackage's build output up to date, installing its
 * dependencies first when they are absent.
 *
 * `packages/graph` is deliberately NOT an npm workspace (the repo declares
 * none), and both `node_modules/` and `assets/` are gitignored build output, so
 * a fresh clone or a freshly-merged worktree has neither. Requiring the user to
 * know that `proof-or-stop graph` depends on a subpackage-scoped `npm install`
 * is a product defect, not a documentation gap -- this mirrors what
 * `scripts/ensure-dist.mjs` already does for `packages/main` at pretest time.
 *
 * Checking `app.html` alone is not sufficient. A build run WITHOUT dependencies
 * present still writes app.html and still serves correct story/edge counts, but
 * omits d3 -- and the client then silently falls back to a different rendering
 * path. d3 is a hard `dependency` of the subpackage, so its bundle is treated as
 * a required build output here.
 */
function ensureGraphClientBuilt(
  location: GraphPackageLocation,
  log: (message: string) => void,
): void {
  const appHtml = join(location.assetDir, 'app.html');
  const d3Bundle = join(location.assetDir, 'd3.min.js');
  if (existsSync(appHtml) && existsSync(d3Bundle)) return;

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const runNpm = (args: readonly string[], what: string): void => {
    const result = spawnSync(npm, [...args], {
      cwd: location.packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error?.message.includes('ENOENT')) {
      throw new Error(
        [
          `graph: the browser client is not built, and npm is unavailable to build it.`,
          `  asset dir: ${location.assetDir}`,
          `  → install Node/npm, then: npm --prefix ${location.packageRoot} run build`,
        ].join('\n'),
      );
    }
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      throw new Error(
        [
          `graph: ${what} failed while preparing the browser client.`,
          `  package: ${location.packageRoot}`,
          detail ? `  ${detail.split('\n').slice(-6).join('\n  ')}` : '',
          `  → retry manually: npm --prefix ${location.packageRoot} run build`,
        ].filter(Boolean).join('\n'),
      );
    }
  };

  if (!existsSync(join(location.packageRoot, 'node_modules'))) {
    log('graph: installing browser client dependencies (first run)...');
    runNpm(['install', '--no-audit', '--no-fund'], 'npm install');
  }
  log('graph: building browser client...');
  runNpm(['run', 'build'], 'npm run build');

  // Re-check rather than trust the exit code: build-web.mjs treats several
  // vendor bundles as optional and only warns, so a zero exit does not by
  // itself prove the required output landed.
  const stillMissing = [appHtml, d3Bundle].filter((file) => !existsSync(file));
  if (stillMissing.length > 0) {
    throw new Error(
      [
        `graph: the browser client build completed but required output is missing.`,
        ...stillMissing.map((file) => `  missing: ${file}`),
        `  → build it manually: npm --prefix ${location.packageRoot} run build`,
      ].join('\n'),
    );
  }
}

/** Default HTTP port, mirroring `DEFAULTS.port` in packages/graph/src/core/machine.ts. */
export const GRAPH_DEFAULT_PORT = 8731;

/** The subpackage that owns the graph library, browser client and static assets. */
export const GRAPH_PACKAGE_NAME = '@proof-or-stop/graph';

export interface GraphArgs {
  /** Repository to read. Defaults to the nearest Proof-or-Stop root from cwd. */
  root?: string;
  /** HTTP port for the served graph. Defaults to GRAPH_DEFAULT_PORT. */
  port?: number;
  /** Launch a browser once the server is listening. Defaults to true. */
  open?: boolean;
  /** Print status as JSON and exit without serving. */
  json?: boolean;
  /**
   * Open the graph directly on one story's dossier page (`/story/<id>`) instead of
   * the root graph view. Optional; when omitted the reported URL is unchanged.
   *
   * The id is VALIDATED against the repository being read before the server is
   * started — see `assertGraphStoryExists`.
   */
  story?: string;
}

/** Where the graph subpackage lives, plus the directories its web shell needs. */
export interface GraphPackageLocation {
  /** Package root (the directory holding package.json). */
  readonly packageRoot: string;
  /** Compiled library entry, i.e. the resolved `dist/index.js`. */
  readonly entry: string;
  /** Static browser assets built by `npm --prefix packages/graph run build`. */
  readonly assetDir: string;
  /** Vendored browser bundles, resolved out of the subpackage's node_modules. */
  readonly vendorDir: string;
}

/**
 * Locate the graph subpackage at runtime.
 *
 * Resolution order:
 *   1. Node module resolution for `@proof-or-stop/graph` — the path that works
 *      once the package is installed or linked (including a global install).
 *   2. The in-repo `packages/graph` sibling — the path that works when running
 *      from a source checkout, which has no workspace link tree.
 *
 * Throws a message naming what is missing and the command that fixes it; never
 * returns a half-resolved location.
 */
export function resolveGraphPackage(projectRoot: string): GraphPackageLocation {
  const attempted: string[] = [];

  const fromModuleResolution = ((): string | null => {
    try {
      const require = createRequire(import.meta.url);
      return require.resolve(`${GRAPH_PACKAGE_NAME}/dist/index.js`);
    } catch {
      try {
        const require = createRequire(import.meta.url);
        return require.resolve(GRAPH_PACKAGE_NAME);
      } catch {
        attempted.push(`node module resolution of ${GRAPH_PACKAGE_NAME}`);
        return null;
      }
    }
  })();

  if (fromModuleResolution && existsSync(fromModuleResolution)) {
    // dist/index.js -> dist -> package root
    const packageRoot = dirname(dirname(fromModuleResolution));
    return describeLocation(packageRoot, fromModuleResolution);
  }

  const sibling = join(projectRoot, 'packages', 'graph');
  const siblingEntry = join(sibling, 'dist', 'index.js');
  if (existsSync(siblingEntry)) return describeLocation(sibling, siblingEntry);
  attempted.push(siblingEntry);

  throw new Error(
    [
      `graph: cannot locate the ${GRAPH_PACKAGE_NAME} library.`,
      ...attempted.map((a) => `  tried: ${a}`),
      `  → build it: npm --prefix packages/graph run build`,
    ].join('\n'),
  );
}

function describeLocation(packageRoot: string, entry: string): GraphPackageLocation {
  return {
    packageRoot,
    entry,
    assetDir: join(packageRoot, 'assets'),
    vendorDir: join(packageRoot, 'node_modules'),
  };
}

/**
 * The builtin module that sets this subpackage's Node floor.
 *
 * `packages/graph/src/core/search/fn.ts` imports `DatabaseSync` from it to build the
 * FTS5 index. It is the ONLY reason the floor exists, so it is the thing the failure
 * message has to name — "upgrade Node" without saying why is not diagnosable.
 */
export const GRAPH_REQUIRED_BUILTIN = 'node:sqlite';

/** Inputs the runtime-support decision is made from. Injectable so the failure path is testable. */
export interface GraphRuntimeProbe {
  /** The running Node version, i.e. `process.versions.node`. */
  readonly nodeVersion: string;
  /** Whether `node:sqlite` can actually be loaded in this process. */
  readonly builtinAvailable: boolean;
  /** The `engines.node` range declared by packages/graph, or null if unreadable. */
  readonly requiredRange: string | null;
}

/**
 * Read `engines.node` out of the graph subpackage's own manifest.
 *
 * Deliberately NOT a second hardcoded "22.5.0" in this file. The floor is a property of
 * `packages/graph` (it is that package that imports `node:sqlite`), and a copy here would
 * be free to drift from the manifest that npm actually enforces on install. Reading it
 * keeps one source of truth; if the manifest is unreadable we degrade to a message that
 * omits the range rather than inventing one.
 */
export function readGraphEnginesRange(packageRoot: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      engines?: { node?: unknown };
    };
    const range = manifest.engines?.node;
    return typeof range === 'string' && range.trim().length > 0 ? range.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this runtime can host the graph library, and if not, say why readably.
 *
 * Pure: every input arrives through `probe`, so the unsupported branch can be exercised
 * directly with an old version string instead of requiring an old Node binary. Returns
 * null when the runtime is fine.
 *
 * Capability over version parsing: the check is "can `node:sqlite` be loaded", not a
 * semver comparison against `engines.node`. Parsing the range would re-derive an answer
 * the runtime can just be asked for, and would go wrong on exactly the runtimes that
 * matter (an odd build with the module compiled out still satisfies `>=22.5.0`). The
 * required range is still REPORTED, because that is what tells the reader what to do.
 */
export function graphRuntimeUnsupportedMessage(probe: GraphRuntimeProbe): string | null {
  if (probe.builtinAvailable) return null;
  const required = probe.requiredRange
    ? `requires Node ${probe.requiredRange}`
    : `requires a newer Node (see engines.node in packages/graph/package.json)`;
  return [
    `graph: this Node runtime cannot load ${GRAPH_REQUIRED_BUILTIN}, which the graph`,
    `  full-text index is built on.`,
    `  running Node: v${probe.nodeVersion}`,
    `  ${GRAPH_PACKAGE_NAME} ${required}`,
    `  → upgrade Node, then re-run: proof-or-stop graph`,
  ].join('\n');
}

/** Probe the live runtime for `node:sqlite` support without letting the failure escape. */
export function graphBuiltinAvailable(): boolean {
  try {
    // `process.getBuiltinModule` is itself Node >= 22.3, so it cannot be assumed on the
    // very runtimes this guard exists to reject; fall back to require() when absent.
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof get === 'function') return get(GRAPH_REQUIRED_BUILTIN) != null;
    createRequire(import.meta.url)(GRAPH_REQUIRED_BUILTIN);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail readably before the graph library is imported.
 *
 * Placement is load-bearing: `packages/graph`'s entry pulls in `node:sqlite` transitively,
 * so the `await import(...)` below is itself what throws on an old runtime — and it throws
 * a raw `ERR_UNKNOWN_BUILTIN_MODULE` stack naming an internal file, with no mention of the
 * required version. A guard after the import cannot produce a better message because there
 * is nothing left to guard. Hence: check first, then import.
 */
export function assertGraphRuntimeSupported(packageRoot: string): void {
  const message = graphRuntimeUnsupportedMessage({
    nodeVersion: process.versions.node,
    builtinAvailable: graphBuiltinAvailable(),
    requiredRange: readGraphEnginesRange(packageRoot),
  });
  if (message !== null) throw new Error(message);
}

/** Minimal shape of the graph library surface this handler consumes. */
interface GraphLibrary {
  createApp: (opts: { root: string; onLog?: (m: string) => void; readManagedRuns?: () => ManagedRunDashboard }) => GraphApp;
  startServer: (o: {
    app: GraphApp;
    port: number;
    assetDir: string;
    vendorDir?: string;
  }) => Promise<{ close: (cb?: () => void) => unknown }>;
  findRoot: (start: string) => { root: string | null; reason: string };
  openBrowser: (url: string) => void;
  /**
   * Story resolution for the repository at `root`. Already part of the graph
   * package's exported surface (packages/graph/src/index.ts), so `--story`
   * validation reuses it rather than widening that surface with a new export.
   * `primary` maps story id -> the directory holding that story's LIVE state,
   * i.e. exactly the set of ids the served graph can show a dossier for.
   */
  resolveStories: (root: string) => { primary: Readonly<Record<string, string>> };
}

/**
 * How many near-miss ids the unknown-story error names.
 *
 * Enough to cover a plausible typo without turning the message into a dump of a
 * repository that holds hundreds of stories.
 */
export const GRAPH_STORY_SUGGESTION_LIMIT = 5;

/** Levenshtein distance, iterative two-row form. Small inputs (story ids), so no memo cache. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Rank the known ids that a mistyped `--story` most plausibly meant.
 *
 * Two signals, prefix first: `B-9f` should surface every `B-9f*` story even in a
 * repository where some unrelated id happens to be one edit away. Ties inside each
 * band are broken alphabetically so the message is deterministic — a suggestion
 * list that reshuffles between runs is not quotable in a bug report.
 *
 * Pure and exported so the ranking can be tested without a repository on disk.
 */
export function graphStorySuggestions(
  requested: string,
  known: readonly string[],
  limit: number = GRAPH_STORY_SUGGESTION_LIMIT,
): string[] {
  const needle = requested.trim().toLowerCase();
  if (needle.length === 0) return [];
  const scored = known.map((id) => {
    const hay = id.toLowerCase();
    const shares = hay.startsWith(needle) || needle.startsWith(hay);
    return { id, band: shares ? 0 : 1, distance: editDistance(needle, hay) };
  });
  return scored
    .filter((c) => c.band === 0 || c.distance <= Math.max(2, Math.ceil(needle.length / 3)))
    .sort((x, y) => x.band - y.band || x.distance - y.distance || x.id.localeCompare(y.id))
    .slice(0, Math.max(0, limit))
    .map((c) => c.id);
}

/**
 * Refuse an unknown `--story` BEFORE anything is served.
 *
 * Placement mirrors the `--root` refusal above and exists for the same reason: a
 * typo must not be indistinguishable from a working session. Serving
 * `/story/B-typo` would answer 200 with an empty dossier, which reads as "this
 * story has no evidence" rather than "you named a story that does not exist".
 *
 * Exported and taking the id set directly (not a repository path), so both the
 * CLI path and a schema-bypassing internal call funnel through one rule — the
 * Zod `z.string()` in the catalog is only the first line of defence
 * (CLAUDE.md, "Handler 编码约定").
 */
export function assertGraphStoryExists(story: unknown, knownIds: readonly string[]): string {
  if (typeof story !== 'string' || story.trim().length === 0) {
    throw new Error(
      [
        `graph: --story requires a story id.`,
        `  received: ${story === undefined ? '(nothing)' : JSON.stringify(story)}`,
        `  → name a story: proof-or-stop graph --story=<id>`,
      ].join('\n'),
    );
  }
  const requested = story.trim();
  if (knownIds.includes(requested)) return requested;

  const suggestions = graphStorySuggestions(requested, knownIds);
  return ((): never => {
    throw new Error(
      [
        `graph: --story=${requested} is not a story in this repository.`,
        `  known stories: ${knownIds.length}`,
        ...(suggestions.length > 0
          ? [`  did you mean: ${suggestions.join(', ')}`]
          : [`  no similarly named story was found`]),
        `  → list what exists: proof-or-stop graph --json`,
      ].join('\n'),
    );
  })();
}

interface GraphApp {
  root: string;
  getStatus: () => Record<string, unknown>;
  close: () => void;
}

/**
 * How often the serving handler pokes `ctx.log`.
 *
 * The CLI watchdog kills a non-structured command after five minutes with no
 * log output (`cli-engine.ts`), which would otherwise end a browsing session
 * mid-use. One minute is well inside that window and quiet enough to read.
 */
export const GRAPH_HEARTBEAT_MS = 60_000;

export function createGraphHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * proof-or-stop graph [--root=<dir>] [--port=<n>] [--no-open] [--json] [--story=<id>]
     *
     * Reads story state, builds the index, and — unless `--json` was passed —
     * serves the browser client until the process is interrupted. Behavior
     * mirrors the standalone shell this command replaced (B-3e16 deleted it as
     * unreachable once `bin` was dropped; see git history or the pre-migration
     * proof-or-stop-graph repository): the same default port, the same cwd-based
     * repository discovery, the same `--json` / `--no-open` semantics, and the
     * same signal shutdown. B-9f2c adds `--story=<id>`, which only changes the
     * path of the reported/opened URL; every other behavior is unchanged.
     */
    async graph(args: GraphArgs = {}) {
      // `ctx.log` is optional on HandlerContext, but the heartbeat below is
      // load-bearing (it is what keeps the CLI watchdog from killing a serving
      // session). Bind it once, with a stderr fallback matching the CLI's own
      // logger, so a context without a logger still resets the activity clock
      // instead of silently dropping the heartbeat.
      const log = ctx.log ?? ((m: string) => process.stderr.write(`${m}\n`));
      const location = resolveGraphPackage(ctx.root);
      // Must precede the import: the import is what throws ERR_UNKNOWN_BUILTIN_MODULE on
      // a runtime older than the node:sqlite floor. See assertGraphRuntimeSupported.
      assertGraphRuntimeSupported(location.packageRoot);
      // pathToFileURL, not `file://${...}`: a repo path containing `#` or `?` would
      // otherwise be parsed as a URL fragment/query and the module would fail to load
      // (verified: `file:///tmp/my#dir/app.js` yields pathname=/tmp/my). Found by codex
      // as an independent review host (B-3e16).
      const lib = await import(pathToFileURL(location.entry).href) as GraphLibrary;

      // `path.resolve` matches the source shell: a relative --root is resolved
      // against cwd rather than handed to the app verbatim.
      /* An explicit --root is VALIDATED, not trusted. Passing it through unchecked made a
         typo indistinguishable from an empty repository: `--root=/nonexistent` exited 0
         reporting `stories: 0, edges: 0`, and the serving path started a real server on a
         real port showing an empty graph. That silently contradicts the worktree-precedence
         warning in CLAUDE.md, whose whole point is that reading the wrong directory
         misreports story state. Found by an independent review host (B-3e16 round 3), which
         also noted this package's own audit task already refuses the same input. */
      const probe = args.root
        ? ((): { root: string | null; reason: string } => {
            const explicit = resolve(args.root);
            const checked = lib.findRoot(explicit);
            return checked.root === explicit
              ? { root: explicit, reason: 'explicit --root' }
              : { root: null, reason: `--root=${explicit} is not a Proof-or-Stop repository (no story directory found there)` };
          })()
        : lib.findRoot(process.cwd());
      if (!probe.root) {
        throw new Error(
          [
            `graph: ${probe.reason}`,
            'Run it inside a Proof-or-Stop repository, or pass --root=<dir>.',
          ].join('\n'),
        );
      }

      /* Refuse an unknown --story here — AHEAD of the --json branch, and therefore
         ahead of every asset check and of startServer.

         Ahead of --json deliberately: `--story` is an assertion about the repository
         ("this id exists"), and a query that silently ignores a typo would report a
         healthy status for a story the caller never actually named. The refusal costs
         one story scan and, unlike the asset/port checks below, does NOT reintroduce
         a build dependency — resolveStories reads story state only, which is what
         --json already does. So --json keeps working without the browser client
         being built; it just no longer accepts an id that does not exist.

         Re-validated at the handler entry rather than trusting the catalog's
         `z.string().optional()`: an internal call or a stale payload that never went
         through the schema must be refused identically (CLAUDE.md, Handler 编码约定). */
      const story =
        args.story === undefined
          ? null
          : assertGraphStoryExists(args.story, Object.keys(lib.resolveStories(probe.root).primary));

      // --json is pure status: build nothing, listen on nothing, close the app.
      // Keep this branch ahead of every asset/port check so a machine-readable
      // status query never depends on the browser client being built.
      if (args.json === true) {
        const jsonApp = lib.createApp({ root: probe.root, readManagedRuns: () => readManagedRunDashboard(probe.root!) });
        try {
          return jsonApp.getStatus();
        } finally {
          jsonApp.close();
        }
      }

      // Build the browser client on demand rather than telling the user to run a
      // subpackage command they have no reason to know about. `packages/graph` is
      // not an npm workspace and its node_modules/ and assets/ are both gitignored
      // build output, so a fresh clone has neither.
      //
      // BOTH are checked, not just app.html. A build run without dependencies
      // present still emits app.html and still serves correct story/edge counts,
      // but omits d3 -- and the page then silently falls back to a different
      // rendering. Checking only app.html let that degraded state look healthy.
      ensureGraphClientBuilt(location, log);

      const port = args.port ?? GRAPH_DEFAULT_PORT;
      const app = lib.createApp({ root: probe.root, onLog: (m) => log(m), readManagedRuns: () => readManagedRunDashboard(probe.root!) });

      let server: { close: (cb?: () => void) => unknown };
      try {
        const status = app.getStatus();
        log(`graph root: ${app.root}`);
        log(
          `graph ${status.stories} stories · ${status.edges} relations · ${status.indexRows} indexed rows`,
        );
        server = await lib.startServer({
          app,
          port,
          assetDir: location.assetDir,
          vendorDir: location.vendorDir,
        });
      } catch (e) {
        app.close();
        const msg = e instanceof Error ? e.message : String(e);
        // Same guidance as the source shell: name the port, then suggest the
        // next one, because "EADDRINUSE" alone does not tell you what to do.
        throw new Error(
          [
            `graph: cannot listen on port ${port}: ${msg}`,
            `  → try another port: proof-or-stop graph --port=${port + 1}`,
          ].join('\n'),
        );
      }

      // encodeURIComponent, not raw interpolation: a story id is caller input, and a
      // `#`, `?` or space in it would otherwise cut the path short or split it into a
      // query/fragment, opening the browser somewhere other than the named dossier.
      // Without --story the string is byte-identical to what it was before B-9f2c.
      const url = story === null
        ? `http://localhost:${port}/`
        : `http://localhost:${port}/story/${encodeURIComponent(story)}`;
      if (args.open !== false) lib.openBrowser(url);

      // The handler owns the process from here until a signal arrives. Resolving
      // this Promise would let the CLI print a result and exit, tearing down the
      // server, so it stays pending for the lifetime of the served process —
      // the same shape `serve` uses (handlers/verifier.ts).
      return await new Promise<string>((resolveResult) => {
        // Keep the watchdog's activity clock fresh; see the WATCHDOG note above.
        const heartbeat = setInterval(() => {
          log(`graph serving ${url}`);
        }, GRAPH_HEARTBEAT_MS);
        heartbeat.unref();

        let stopping = false;
        const shutdown = (signal: string) => {
          // Signals can arrive more than once (^C held down, or SIGINT then
          // SIGTERM); closing twice would throw ERR_SERVER_NOT_RUNNING.
          if (stopping) return;
          stopping = true;
          clearInterval(heartbeat);
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
          try {
            server.close();
          } catch { /* already closing; the app still has to be closed */ }
          app.close();
          resolveResult(`graph stopped (${signal})`);
        };
        const onSigint = () => shutdown('SIGINT');
        const onSigterm = () => shutdown('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);

        log(`graph serving ${url}`);
        process.stdout.write(
          [
            `  graph`,
            `  root: ${probe.root} (${probe.reason})`,
            `  ${url}`,
            '',
            `  Serving until interrupted (Ctrl-C). The CLI watchdog stops any`,
            `  command after 15 minutes; raise PROOF_OR_STOP_MAX_TIMEOUT_MS for`,
            `  a longer session.`,
            '',
          ].join('\n'),
        );
      });
    },
  };
}
