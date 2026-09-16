import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// The doctor's "Nested reservation fences" surface is exercised against a private OS-home
// machine pool seeded with every residual shape the classifier distinguishes: no pool, a
// ticket without a residual record, a malformed record, a live registered group, a pending
// fence with a live proven target, a marked fence with a noted spawned PID under a live owner,
// a targetless marked fence under a dead owner, and an unreadable pool. The scan and the
// renderer are controlled directly (exported by a source hook that changes nothing else),
// and the real doctor handler is run in a hermetic project for its JSON `fencedMachineTickets`
// block and its rendered section. Real kernel process identities; no synthetic tickets in
// the user's own pool, and the doctor never signals or releases anything.
const repo=process.cwd(),runtime=nestedSourceRuntime(repo),{base,delegation,lock,env,writeLoader}=runtime;
const doctor=pathToFileURL(join(repo,'packages/main/src/handlers/doctor.ts')).href;
const store=pathToFileURL(join(repo,'packages/main/src/core/store.ts')).href;
const burn=pathToFileURL(join(repo,'packages/main/src/core/usage-burn-alert.ts')).href;
const mutation=process.env.CONTROLLED_DOCTOR_MUTATION??'';
writeLoader(`function patch(url,source){if(url!==${JSON.stringify(doctor)})return source;for(const name of ['scanFencedMachineTickets','renderFencedMachineTickets']){const a='function '+name+'(';if(source.split(a).length!==2)throw Error('doctor fence anchor changed: '+name);source=source.replace(a,'export '+a);}
const mutation=${JSON.stringify(mutation)};
if(mutation==='drop-in-flight'){const a='inFlight += projection.inFlight;';if(source.split(a).length!==2)throw Error('mutation anchor');source=source.replace(a,'inFlight += 0;');}
if(mutation==='swallow-pool-error'){const a="if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { pool, fenced, inFlight, error: (error as Error).message };";if(source.split(a).length!==2)throw Error('mutation anchor');source=source.replace(a,'');}
if(mutation==='drop-json-field'){const a='          fencedMachineTickets,\\n';if(source.split(a).length!==2)throw Error('mutation anchor');source=source.replace(a,'');}
return source;}`);
const entry=join(base,'doctor-fence.mjs');
writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(entry,`import assert from 'node:assert/strict';import {spawn,execFileSync} from 'node:child_process';import {mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';import {join} from 'node:path';
const api=await import(${JSON.stringify(delegation)});const {canonicalMachineCapacityRoot}=await import(${JSON.stringify(lock)});
const {scanFencedMachineTickets:scan,renderFencedMachineTickets:render,createDoctorHandlers}=await import(${JSON.stringify(doctor)});
const {StoryStore}=await import(${JSON.stringify(store)});const {BURN_ALERT_ENV}=await import(${JSON.stringify(burn)});
const base=${JSON.stringify(base)};const pool=canonicalMachineCapacityRoot();
assert.ok(pool.startsWith(base),'the control must only ever touch the private OS-home pool: '+pool);
const residual=api.VALIDATION_DELEGATION_RESIDUAL_FILE;const header='Nested reservation fences (machine tickets):';
const none='  none: every machine ticket residual row is provably resolved, absent or in flight under a live owner';
const recovery=/^  → Live registered groups, live targets and noted spawned PIDs resolve on their own once absent\\./;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const identity=pid=>{let last;for(let i=0;i<20;i++){try{return api.observeValidationReservationChild(pid);}catch(error){last=error;execFileSync(process.execPath,['-e','setTimeout(()=>{},25)']);}}throw last;};
const sleepers=[];const sleeper=async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise(r=>child.once('spawn',r));sleepers.push(child);return child;};
try{
 // 1. No pool directory: nothing fenced, nothing in flight, no error, and the renderer says so.
 let observed=scan();assert.deepEqual({...observed},{pool,fenced:[],inFlight:0});
 assert.deepEqual(render(observed),[header,none]);
 // 2. Every residual shape at once.
 mkdirSync(pool,{recursive:true});
 const ticket=name=>{const dir=join(pool,name+'.ticket');mkdirSync(dir,{recursive:true});return dir;};
 const write=(dir,rows)=>writeFileSync(join(dir,residual),typeof rows==='string'?rows:JSON.stringify(rows));
 const self=identity(process.pid);
 const registered=await sleeper(),target=await sleeper(),noted=await sleeper();
 const exited=spawn(process.execPath,['-e','']);const deadPid=await new Promise(r=>exited.once('exit',()=>r(exited.pid)));
 ticket('t1-no-record');
 write(ticket('t2-malformed'),'{not json');
 write(ticket('t3-registered-live'),[{pid:registered.pid,pgid:registered.pid,start:identity(registered.pid).start}]);
 write(ticket('t4-target-live'),[{pending:'tok4',pid:process.pid,start:self.start,spawnAttempted:true,spawnedPid:target.pid,target:{pid:target.pid,pgid:target.pid,start:identity(target.pid).start}}]);
 write(ticket('t5-noted-live-owner'),[{pending:'tok5',pid:process.pid,start:self.start,spawnAttempted:true,spawnedPid:noted.pid}]);
 write(ticket('t6-targetless-dead-owner'),[{pending:'tok6',pid:deadPid,start:1,spawnAttempted:true}]);
 writeFileSync(join(pool,'not-a-ticket.txt'),'ignored');
 observed=scan();
 assert.equal(observed.error,undefined,'a readable pool reports no error');assert.equal(observed.pool,pool);
 assert.equal(observed.inFlight,1,'the noted spawn under a live owner is the only in-flight fence: '+JSON.stringify(observed));
 const name=row=>row.ticket.slice(pool.length+1);
 assert.deepEqual(observed.fenced.map(name).sort(),['t2-malformed.ticket','t3-registered-live.ticket','t4-target-live.ticket','t6-targetless-dead-owner.ticket'],JSON.stringify(observed));
 const rows=Object.fromEntries(observed.fenced.map(row=>[name(row),row]));
 assert.equal(rows['t2-malformed.ticket'].malformed,true);
 assert.deepEqual([rows['t3-registered-live.ticket'].registeredLive,rows['t3-registered-live.ticket'].pendingTargetLive,rows['t3-registered-live.ticket'].pendingSpawnedLive,rows['t3-registered-live.ticket'].pendingTargetless],[1,0,0,0]);
 assert.deepEqual([rows['t4-target-live.ticket'].registeredLive,rows['t4-target-live.ticket'].pendingTargetLive,rows['t4-target-live.ticket'].pendingSpawnedLive,rows['t4-target-live.ticket'].pendingTargetless],[0,1,0,0]);
 assert.deepEqual([rows['t6-targetless-dead-owner.ticket'].pendingTargetless,rows['t6-targetless-dead-owner.ticket'].deadOwners,rows['t6-targetless-dead-owner.ticket'].pendingSpawnedLive],[1,1,0]);
 let lines=render(observed);
 assert.equal(lines[0],header);
 assert.equal(lines.find(l=>l.includes('t2-malformed')),'  ⚠ '+join(pool,'t2-malformed.ticket')+': malformed residual record; the ticket stays fenced');
 assert.equal(lines.find(l=>l.includes('t3-registered-live')),'  ⚠ '+join(pool,'t3-registered-live.ticket')+': 1 live or unobservable registered group(s), 0 pending fence(s) with a live target, 0 pending fence(s) whose noted spawned PID or group is still present, 0 pending fence(s) without an observed target whose owner is dead');
 assert.equal(lines.find(l=>l.includes('t4-target-live')),'  ⚠ '+join(pool,'t4-target-live.ticket')+': 0 live or unobservable registered group(s), 1 pending fence(s) with a live target, 0 pending fence(s) whose noted spawned PID or group is still present, 0 pending fence(s) without an observed target whose owner is dead');
 assert.equal(lines.find(l=>l.includes('t6-targetless')),'  ⚠ '+join(pool,'t6-targetless-dead-owner.ticket')+': 0 live or unobservable registered group(s), 0 pending fence(s) with a live target, 0 pending fence(s) whose noted spawned PID or group is still present, 1 pending fence(s) without an observed target whose owner is dead');
 assert.ok(!lines.some(l=>l.includes('t5-noted-live-owner')),'an in-flight noted fence is never listed as fenced');
 assert.ok(!lines.some(l=>l.includes('t1-no-record')),'a ticket without a residual record is never listed');
 assert.deepEqual(lines.filter(l=>l.startsWith('  ℹ ')),['  ℹ 1 pending fence(s) in flight under a live owner (a command between preparing and registering its spawn); not fenced']);
 assert.match(lines.at(-1),recovery);assert.equal(lines.length,7,lines.join('\\n'));
 // 3. The real doctor handler carries the same scan in its JSON block and renders the same section.
 const project=join(base,'project');mkdirSync(project,{recursive:true});
 for(const args of [['init','-q','-b','main'],['config','user.email','control@test.local'],['config','user.name','control'],['config','commit.gpgsign','false']])execFileSync('git',args,{cwd:project,stdio:'ignore'});
 writeFileSync(join(project,'proof-or-stop.config.json'),JSON.stringify({storyDir:'.proof-or-stop/story/actives'},null,2));
 writeFileSync(join(project,'seed.txt'),'seed\\n');execFileSync('git',['add','seed.txt','proof-or-stop.config.json'],{cwd:project,stdio:'ignore'});execFileSync('git',['commit','-q','-m','seed'],{cwd:project,stdio:'ignore'});
 for(const key of [BURN_ALERT_ENV.codexDir,BURN_ALERT_ENV.claudeDir]){const dir=join(base,'empty-'+key);mkdirSync(dir,{recursive:true});process.env[key]=dir;}
 process.env.PROOF_OR_STOP_HEALTH_PATH=join(base,'health.jsonl');
 const handlers=createDoctorHandlers({store:new StoryStore(project),root:project,scanRoot:project});
 const quiet=async run=>{const out=process.stdout.write.bind(process.stdout),err=process.stderr.write.bind(process.stderr);process.stdout.write=()=>true;process.stderr.write=()=>true;try{return await run();}finally{process.stdout.write=out;process.stderr.write=err;}};
 const json=await quiet(()=>handlers.doctor({format:'json'}));
 assert.ok(json&&typeof json==='object'&&json.fencedMachineTickets,'the doctor JSON summary must carry the fencedMachineTickets block');
 assert.deepEqual({...json.fencedMachineTickets,fenced:json.fencedMachineTickets.fenced.map(row=>({...row}))},{...observed,fenced:observed.fenced.map(row=>({...row}))},'the JSON block is the scan');
 const text=String(await quiet(()=>handlers.doctor({format:'text'})));
 assert.ok(text.includes(lines.join('\\n')),'the rendered doctor report must carry the fence section verbatim');
 // 4. Only the in-flight fence left: the none line and the advisory, nothing fenced.
 for(const name of ['t2-malformed','t3-registered-live','t4-target-live','t6-targetless-dead-owner'])rmSync(join(pool,name+'.ticket'),{recursive:true,force:true});
 observed=scan();assert.deepEqual({...observed},{pool,fenced:[],inFlight:1});
 assert.deepEqual(render(observed),[header,none,'  ℹ 1 pending fence(s) in flight under a live owner (a command between preparing and registering its spawn); not fenced']);
 // 5. An unreadable pool populates the error field instead of throwing out of the doctor.
 rmSync(pool,{recursive:true,force:true});writeFileSync(pool,'not a directory');
 observed=scan();assert.match(String(observed.error),/ENOTDIR/,'a pool that is not a directory reports its error: '+JSON.stringify(observed));assert.deepEqual(observed.fenced,[]);assert.equal(observed.inFlight,0);
 lines=render(observed);assert.equal(lines.length,2);assert.equal(lines[0],header);assert.match(lines[1],/^  ⚠ unavailable: .*ENOTDIR/);
 const unreadable=await quiet(()=>handlers.doctor({format:'json'}));assert.match(String(unreadable.fencedMachineTickets.error),/ENOTDIR/,'the JSON block carries the pool error');
 console.log('DOCTOR_FENCE_PROJECTION PASS '+JSON.stringify({fenced:4,inFlight:1,shapes:['no-pool','no-record','malformed','registered-live','target-live','noted-live-owner','targetless-dead-owner','unreadable-pool']}));
}finally{for(const child of sleepers){try{process.kill(-child.pid,'SIGKILL');}catch{}}}
`);
try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:40000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'DOCTOR_FENCE_PROJECTION');assert.match(child.stdout,/DOCTOR_FENCE_PROJECTION PASS/);console.log('NESTED_DOCTOR_FENCE_PROJECTION PASS');}
finally{rmSync(base,{recursive:true,force:true});}
