/**
 * @task B-3e16
 * @checklist CHK-003
 * @title register the graph command across the command surfaces
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
 *   SCOPE — CHK-003 registers the command and reports real, resolved status.
 *   Actually serving the browser client end to end is CHK-004; until then this
 *   handler says so plainly rather than reporting a success it did not achieve.
 * @changes
 *   - [CHK-003] Add the graph handler behind the runtime package resolution seam.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

export function createGraphHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * proof-or-stop graph [--root=<dir>] [--port=<n>] [--no-open] [--json]
     *
     * CHK-003 registers the command and reports the resolved graph app status
     * read through the library surface. Serving the browser client is CHK-004,
     * and this handler states that instead of claiming to serve.
     */
    async graph(args: GraphArgs = {}) {
      const location = resolveGraphPackage(ctx.root);

      const lib = await import(`file://${location.entry}`) as {
        createApp: (opts: { root: string; onLog?: (m: string) => void }) => {
          root: string;
          getStatus: () => Record<string, unknown>;
          close: () => void;
        };
        findRoot: (start: string) => { root: string | null; reason: string };
      };

      const probe = args.root
        ? { root: args.root, reason: 'explicit --root' }
        : lib.findRoot(process.cwd());
      if (!probe.root) {
        throw new Error(
          [
            `graph: ${probe.reason}`,
            'Run it inside a Proof-or-Stop repository, or pass --root=<dir>.',
          ].join('\n'),
        );
      }

      const app = lib.createApp({ root: probe.root });
      let status: Record<string, unknown>;
      try {
        status = app.getStatus();
      } finally {
        app.close();
      }

      if (args.json === true) return status;

      const port = args.port ?? GRAPH_DEFAULT_PORT;
      return [
        `  graph`,
        `  root: ${probe.root} (${probe.reason})`,
        `  ${status.stories} stories · ${status.edges} relations · ${status.indexRows} indexed rows`,
        `  assets: ${location.assetDir}${existsSync(location.assetDir) ? '' : ' (missing — run: npm --prefix packages/graph run build)'}`,
        '',
        `  Not serving yet: the HTTP server and browser client are not wired into`,
        `  this command (B-3e16 CHK-004). Requested port ${port}, open=${args.open !== false}.`,
        `  Until CHK-004 lands, use --json for machine-readable status.`,
      ].join('\n');
    },
  };
}
