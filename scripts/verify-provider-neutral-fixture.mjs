import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderNeutralFixture, inspectFixtureProcess, terminateOwnedFixture } from './helpers/provider-neutral-fixture.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-fixture-test-')));
const helper = fileURLToPath(new URL('./helpers/provider-neutral-fixture.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFile = async path => { for (let i=0;i<100&&!existsSync(path);i++) await pause(100); assert.ok(existsSync(path)); };
const alive = pid => { try { process.kill(pid,0);return true; } catch { return false; } };
try {
  const good = join(root, 'good.mjs');writeFileSync(good,"console.log('NEUTRAL_ACTUAL_CHILD_PASS');\n");
  assert.equal((await runProviderNeutralFixture(good,[],process.env)).status,0);
  const marker = join(root,'started');const slow=join(root,'slow.mjs');
  writeFileSync(slow,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);\n`);
  await assert.rejects(runProviderNeutralFixture(slow,[],process.env,{timeoutMs:1000}),/deadline/);
  assert.ok(existsSync(marker),'timeout witness actually started the child');assert.equal(alive(Number(readFileSync(marker,'utf8'))),false,'timeout must reap real child');rmSync(marker);
  const outer=join(root,'outer.mjs');writeFileSync(outer,`import{runProviderNeutralFixture}from ${JSON.stringify(new URL('./helpers/provider-neutral-fixture.mjs',import.meta.url).href)};await runProviderNeutralFixture(${JSON.stringify(slow)},[],process.env);`);
  const signalled=spawn(process.execPath,[outer],{stdio:'ignore'});const exited=new Promise(resolve=>signalled.once('exit',resolve));await waitFile(marker);const childPid=Number(readFileSync(marker,'utf8'));signalled.kill('SIGTERM');assert.notEqual(await exited,0);assert.equal(alive(childPid),false,'outer signal must reap real child');rmSync(marker);
  const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{owned.once('spawn',resolve);owned.once('error',reject)});const identity=inspectFixtureProcess(owned.pid);assert.ok(identity);try{assert.equal(await terminateOwnedFixture({...identity,fingerprint:'wrong'}),false);assert.equal(alive(owned.pid),true,'mismatched fingerprint must never signal');}finally{assert.equal(await terminateOwnedFixture(identity),true);}
  const noGrant=join(root,'no-grant');(await import('node:fs')).mkdirSync(noGrant);const boot=spawnSync(process.execPath,[helper,'--bootstrap',noGrant,slow],{stdio:'ignore'});assert.equal(boot.status,0);const ungranted=JSON.parse(readFileSync(join(noGrant,'owner.json'),'utf8'));for(let n=0;n<130&&alive(ungranted.pid);n++)await pause(100);assert.equal(alive(ungranted.pid),false,'ungranted worker self-terminates');assert.equal(existsSync(marker),false,'no grant means zero suite launch');
  console.log('PASS neutral fixture real exit, timeout, signal, fingerprint refusal, and absent grant');
} finally { rmSync(root,{recursive:true,force:true}); }
