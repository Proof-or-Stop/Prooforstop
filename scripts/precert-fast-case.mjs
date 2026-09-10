#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAST_CONTRACTS } from './precert-fast-contracts.mjs';
import { validateSelectorReceiptCore } from './full-suite-selector-contract.mjs';
import { writeBuildBinding, verifyBuildBinding } from './full-suite-build-binding.mjs';

const root = process.cwd();
const [id, ...extra] = process.argv.slice(2);
const contract = FAST_CONTRACTS.find(row => row.contractId === id);
assert.ok(contract && extra.length === 0, 'one registered fast contract ID is required');
verifyBuildBinding(root);
const temporary = mkdtempSync(join(tmpdir(),'precert-fast-'));
const invoke = (script,args=[]) => execFileSync(process.execPath,[script,...args],
  {cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
try {
  if (id === 'selector-integrity') {
    const selector = 'precert.selector.predicate-required';
    const current = {head:'fixture-head',material:'fixture-material'};
    const files = {validator:'fixture-source-digest'};
    const valid = {schema:'b9812.full-suite-contract-capture.v2',...current,fileDigests:files,
      predicates:{[selector]:{passed:true,outputDigest:createHash('sha256').update(`VERIFIED ${selector}`).digest('hex')}}};
    const validate = receipt => validateSelectorReceiptCore(receipt,selector,current,files,(a,b)=>a===b);
    for (const displayCount of [25,27,83,85]) validate({...valid,displayCount});
    for (const mutate of [value=>{value.predicates[selector].passed=false;},
      value=>{delete value.predicates[selector];},value=>{value.material='changed';},
      value=>{value.head='changed';},value=>{value.fileDigests.validator='changed';},
      value=>{value.predicates[selector].outputDigest='changed';}]) {
      const changed = structuredClone(valid); mutate(changed);
      assert.throws(()=>validate(changed),'a changed predicate or identity must be refused');
    }
    // The mutant alters the SAME validator used by the historical production selector.
    const moduleUrl = pathToFileURL(resolve('scripts/full-suite-selector-contract.mjs')).href;
    const anchor = 'assert.equal(receipt.predicates[selector].passed, true,';
    const loader = join(temporary,'mutate.mjs');
    writeFileSync(loader,`import {readFileSync} from 'node:fs';
export async function load(url,context,next) {
  if (url !== ${JSON.stringify(moduleUrl)}) return next(url,context);
  const source = readFileSync(new URL(url),'utf8');
  if (source.split(${JSON.stringify(anchor)}).length !== 2) throw new Error('selector mutation anchor changed');
  return {format:'module',shortCircuit:true,source:source.replace(${JSON.stringify(anchor)},'assert.equal(true, true,')};
}`);
    const register = join(temporary,'register.mjs');
    writeFileSync(register,`import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
    const witness = join(temporary,'witness.mjs');
    writeFileSync(witness,`import assert from 'node:assert/strict';
import {validateSelectorReceiptCore as validate} from ${JSON.stringify(moduleUrl)};
const receipt = ${JSON.stringify(valid)};
receipt.predicates[${JSON.stringify(selector)}].passed=false;
assert.throws(()=>validate(receipt,${JSON.stringify(selector)},${JSON.stringify(current)},${JSON.stringify(files)},(a,b)=>a===b),/selector predicate did not pass/,'failed predicate must be rejected');`);
    const normal = spawnSync(process.execPath,[witness],{encoding:'utf8'});
    assert.equal(normal.status,0,`${normal.stdout}${normal.stderr}`);
    const mutant = spawnSync(process.execPath,['--import',register,witness],{encoding:'utf8'});
    assert.equal(mutant.status,1,'actual unconditional-selector mutation must fail the normal witness');
    assert.match(mutant.stderr,/Missing expected exception.*failed predicate must be rejected/);
  } else if (id === 'real-port-collision') {
    const receiptPath = join(temporary,'port.json');
    invoke('packages/main/dist/tasks/full-suite-fixed-port-os-collision.js',['--out',receiptPath]);
    const receipt = JSON.parse(readFileSync(receiptPath,'utf8'));
    assert.equal(receipt.schema,'proof-or-stop.fixed-port-os-collision.v1');
    assert.equal(receipt.capability,'detected'); assert.equal(receipt.normalBind,'PASS');
    assert.equal(receipt.collision.code,'EADDRINUSE'); assert.equal(receipt.collision.status,'TERMINAL_FAIL');
    assert.equal(receipt.cleanupRebind,'PASS'); assert.equal(receipt.overallStatus,'PASS');
  } else if (id === 'causal-launches-zero') {
    const output = invoke('packages/main/dist/tasks/verifier-causal-preflight-smoke.js');
    assert.ok(output.split(/\r?\n/).includes('verifier-causal-preflight-smoke: PASS'));
  } else if (id === 'terminal-process-cleanup') {
    const {cleanupOwnedTargets} = await import('../packages/main/dist/tasks/full-suite-runner.js');
    for (const [name,owner,outcome] of [['owned','ours','removed'],['foreign','theirs','residue'],['missing',null,'residue']]) {
      const path = join(temporary,name); mkdirSync(path);
      if (owner !== null) writeFileSync(join(path,'owner'),`${owner}\n`);
      const result = cleanupOwnedTargets([{path,existedBefore:false,type:'absent',ownerMarker:null}],'ours');
      assert.equal(result[0].outcome,outcome);
      assert.equal(existsSync(path),outcome==='residue','foreign and unmarked targets must survive cleanup');
    }
    const output = invoke('scripts/verify-managed-supervisor-terminal-cleanup.mjs');
    assert.ok(output.split(/\r?\n/).includes('PASS U02 terminal-publication crash recovered; real skip-cleanup mutation discriminated'));
  } else if (id === 'source-dist-launches-zero') {
    const fixture = join(temporary,'project');
    mkdirSync(join(fixture,'packages/main/src'),{recursive:true});
    mkdirSync(join(fixture,'packages/main/dist'),{recursive:true});
    const source = join(fixture,'packages/main/src/input.ts');
    const dist = join(fixture,'packages/main/dist/input.js');
    const valid = 'export const fixture = true;\n';
    writeFileSync(source,valid); writeFileSync(dist,valid);
    writeFileSync(join(fixture,'packages/main/tsconfig.json'),'{}\n');
    writeFileSync(join(fixture,'packages/main/package.json'),'{}\n');
    symlinkSync(join(root,'scripts'),join(fixture,'scripts'),'dir');
    const runner = join(root,'packages/main/dist/tasks/full-suite-runner.js');
    writeFileSync(join(fixture,'package.json'),JSON.stringify({scripts:{test:`node ${JSON.stringify(runner)}`}}));
    const marker = join(fixture,'launched'); const bin = join(fixture,'bin'); mkdirSync(bin);
    // Only the fixture's descendant npm is replaced. The actual npm test and runner are real.
    writeFileSync(join(bin,'npm'),`#!/bin/sh\necho launched > '${marker.replaceAll("'","'\\''")}'\nexit 99\n`);
    chmodSync(join(bin,'npm'),0o700);
    const npm = process.env.npm_execpath ?? execFileSync('which',['npm'],{encoding:'utf8'}).trim();
    const run = () => spawnSync(process.execPath,[npm,'test','--','--unknown'],
      {cwd:fixture,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});
    const positive = () => {
      writeBuildBinding(fixture);
      const result = run(); assert.equal(result.status,1);
      assert.match(`${result.stdout}${result.stderr}`,/unknown argument/,'fresh binding must reach the real argument parser');
      assert.doesNotMatch(`${result.stdout}${result.stderr}`,/source\/dist build binding mismatch/);
    };
    positive();
    for (const path of [source,dist]) {
      writeFileSync(path,'export const fixture = false;\n');
      const result = run(); assert.equal(result.status,1);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output,/source\/dist build binding mismatch/);
      assert.doesNotMatch(output,/unknown argument/);
      assert.equal(existsSync(marker),false,'stale source/dist must refuse before any member launch');
      writeFileSync(path,valid); positive();
    }
  }
  console.log(contract.marker);
} finally { rmSync(temporary,{recursive:true,force:true}); }
