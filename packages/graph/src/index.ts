/** Library surface. `proof-or-stop graph` (packages/main/src/handlers/graph.ts)
 *  consumes it through a single dynamic import of dist/index.js, so anything the
 *  CLI entrypoint needs must be re-exported here rather than deep-imported. */
export { createApp, type App, type AppOptions, type Status } from './core/app.js';
export { startServer, type ServeOptions } from './io/http.js';
export { findRoot, type RootProbe } from './io/find-root.js';
export { openBrowser } from './io/open-browser.js';
export { buildGraph } from './core/graph/fn.js';
export { storyDetail } from './core/detail/fn.js';
export { buildIndex, openIndex, search } from './core/search/fn.js';
export { resolveStories, contentHash, liveHash, readArtifact } from './core/store/fn.js';
export * from './core/data.js';
export * from './core/machine.js';
