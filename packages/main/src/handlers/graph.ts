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
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { HandlerContext } from './context.js';

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
  createApp: (opts: { root: string; onLog?: (m: string) => void }) => GraphApp;
  startServer: (o: {
    app: GraphApp;
    port: number;
    assetDir: string;
    vendorDir?: string;
  }) => Promise<{ close: (cb?: () => void) => unknown }>;
  findRoot: (start: string) => { root: string | null; reason: string };
  openBrowser: (url: string) => void;
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
     * proof-or-stop graph [--root=<dir>] [--port=<n>] [--no-open] [--json]
     *
     * Reads story state, builds the index, and — unless `--json` was passed —
     * serves the browser client until the process is interrupted. Behavior
     * mirrors the standalone shell this command replaced (B-3e16 deleted it as
     * unreachable once `bin` was dropped; see git history or the pre-migration
     * proof-or-stop-graph repository): the same default port, the same cwd-based
     * repository discovery, the same `--json` / `--no-open` semantics, and the
     * same signal shutdown.
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
      const probe = args.root
        ? { root: resolve(args.root), reason: 'explicit --root' }
        : lib.findRoot(process.cwd());
      if (!probe.root) {
        throw new Error(
          [
            `graph: ${probe.reason}`,
            'Run it inside a Proof-or-Stop repository, or pass --root=<dir>.',
          ].join('\n'),
        );
      }

      // --json is pure status: build nothing, listen on nothing, close the app.
      // Keep this branch ahead of every asset/port check so a machine-readable
      // status query never depends on the browser client being built.
      if (args.json === true) {
        const jsonApp = lib.createApp({ root: probe.root });
        try {
          return jsonApp.getStatus();
        } finally {
          jsonApp.close();
        }
      }

      // Fail before listening if the browser client was never built. Serving a
      // blank page instead is the pre-mortem risk recorded in decision.json:
      // the server would answer 200 on /api/* while / returned an error body,
      // which reads as a broken product rather than a missing build step.
      if (!existsSync(join(location.assetDir, 'app.html'))) {
        throw new Error(
          [
            `graph: the browser client is not built.`,
            `  missing: ${join(location.assetDir, 'app.html')}`,
            `  asset dir: ${location.assetDir}`,
            `  → build it: npm --prefix packages/graph run build`,
          ].join('\n'),
        );
      }

      const port = args.port ?? GRAPH_DEFAULT_PORT;
      const app = lib.createApp({ root: probe.root, onLog: (m) => log(m) });

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

      const url = `http://localhost:${port}/`;
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
