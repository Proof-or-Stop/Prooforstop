/** Exercise the actual owned CLI server and its four browser/API routes. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startGraph,fetchGraph} from './graph-process.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const server=await startGraph(repo);
try {
 const html=await (await fetchGraph(server.url)).text();assert.ok(html.toLowerCase().startsWith('<!doctype html'));
 const graph=await (await fetchGraph(server.url,'api/graph')).json();assert.ok(Array.isArray(graph.stories)&&graph.stories.length>0);assert.ok(Array.isArray(graph.edges));
 const status=await (await fetchGraph(server.url,'api/status')).json();assert.equal(status.root,repo);assert.equal(typeof status.stories,'number');
 const search=await (await fetchGraph(server.url,'api/search?q=graph')).json();assert.ok(Array.isArray(search.rows));
 console.log('Served HTML, graph, status and search from owned CLI '+server.url);console.log('SERVES_OK');
} finally {await server.stop();}
