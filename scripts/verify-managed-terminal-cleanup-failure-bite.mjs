import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root=mkdtempSync(join(tmpdir(),'cleanup-exit-bite-'));
const helper=resolve('scripts/verify-managed-supervisor-terminal-cleanup.mjs');
try {
  const normal=execFileSync(process.execPath,[helper],{encoding:'utf8',timeout:30000});
  assert.match(normal,/^PASS U02 terminal-publication crash recovered;/m);
  const loader=join(root,'loader.mjs');
  writeFileSync(loader,`import {readFileSync} from 'node:fs';
export async function load(url,context,next) {
  if(url!==${JSON.stringify(pathToFileURL(helper).href)})return next(url,context);
  const source=readFileSync(new URL(url),'utf8');
  const target=${JSON.stringify("'#!/bin/sh\\nexit 7\\n'")};
  if(source.split(target).length!==2)throw new Error('provider exit mutation anchor changed');
  return {format:'module',shortCircuit:true,source:source.replace(target,${JSON.stringify("'#!/bin/sh\\nexit 8\\n'")})};
}`);
  const register=join(root,'register.mjs');
  writeFileSync(register,`import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
  const mutated=spawnSync(process.execPath,['--import',register,helper],{encoding:'utf8',timeout:30000});
  assert.equal(mutated.error,undefined,'negative control must complete, not time out');
  assert.notEqual(mutated.status,0,'U07 parent must reject a provider exit 8 even when worker errors become terminal records');
  assert.match(mutated.stderr,/parent requires the actual provider exit 7/);
  assert.doesNotMatch(mutated.stdout,/^PASS U02 terminal-publication crash recovered;/m);
  console.log('PASS U07 parent observes real exit 7 and rejects a transformed worker failure');
} finally {rmSync(root,{recursive:true,force:true});}
