/** Verify on-demand client recovery through owned live servers, without a fixed wait. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startGraph,fetchGraph} from './graph-process.mjs';
const pkgRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.resolve(pkgRoot,'../..');
const asset=path.join(pkgRoot,'assets/app.html'),stash=path.join(pkgRoot,'assets/.app.html.verify-stash');
const rebuiltStash=asset+'.rebuilt-probe';
assert.ok(fs.existsSync(asset),'PRECONDITION_FAILED: build graph client first');
assert.ok(!fs.existsSync(stash)&&!fs.existsSync(rebuiltStash),'Refusing to overwrite an interrupted verifier backup');
const original=fs.readFileSync(asset);fs.renameSync(asset,stash);
try {
 for(let pass=0;pass<2;pass++){
  let server;
  try {
   server=await startGraph(repo);
   const html=await (await fetchGraph(server.url)).text();
   assert.ok(fs.existsSync(asset),'Server must not serve without rebuilding its missing client');
   const built=fs.readFileSync(asset,'utf8');
   assert.match(built,/<!doctype html/i);assert.ok(built.includes('openStoryDossier'));
   assert.ok(built.length>=100000,'Client must be a complete built page');
   assert.ok(fs.existsSync(path.join(pkgRoot,'assets/d3.min.js')),'Required d3 bundle is present');
   assert.equal(html,built,'The owned live server must serve the recovered client bytes');
   const status=await (await fetchGraph(server.url,'api/status')).json();assert.equal(status.root,repo);
   console.log('Recovery '+(pass+1)+' served '+html.length+' bytes from '+server.url);
  } finally {if(server)await server.stop();}
  if(pass===0)fs.renameSync(asset,rebuiltStash);
 }
} finally {
 if(fs.existsSync(rebuiltStash))fs.rmSync(rebuiltStash);
 if(fs.existsSync(stash))fs.renameSync(stash,asset);
}
assert.deepEqual(fs.readFileSync(asset),original,'Restore the exact original asset');
console.log('MISSING_ASSETS_HANDLED_OK');

// The refusal branch must run even after normal on-demand recovery succeeds.
await import('./verify-missing-client-no-listener.mjs');
