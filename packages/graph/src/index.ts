/** Library surface, for embedding into the Proof-or-Stop CLI later. */
export { createApp, type App, type AppOptions, type Status } from './core/app.js';
export { startServer, type ServeOptions } from './io/http.js';
export { findRoot, type RootProbe } from './io/find-root.js';
export { buildGraph } from './core/graph/fn.js';
export { storyDetail } from './core/detail/fn.js';
export { buildIndex, openIndex, search } from './core/search/fn.js';
export { resolveStories, contentHash, liveHash, readArtifact } from './core/store/fn.js';
export * from './core/data.js';
export * from './core/machine.js';
