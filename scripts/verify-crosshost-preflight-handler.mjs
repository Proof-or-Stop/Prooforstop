import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join,dirname} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL,fileURLToPath} from 'node:url';import {syncBuiltinESMExports} from 'node:module';
const repo=fs.realpathSync(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fileURLToPath(new URL('..',import.meta.url))),base=fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(),'u08-real-worker-'))),root=join(base,'project'),bin=join(base,'bin');fs.mkdirSync(root);fs.mkdirSync(bin);const fixtureCodexHome=join(base,'codex-home');fs.mkdirSync(fixtureCodexHome);fs.writeFileSync(join(fixtureCodexHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-not-a-real-key'}),{mode:0o600});
const originalUserInfo=os.userInfo;os.userInfo=(...args)=>({...originalUserInfo(...args),homedir:base});syncBuiltinESMExports();
const load=p=>import(pathToFileURL(join(repo,'packages/main/dist',p)).href);
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let workerStarts=0;let snapshotStarts=0;const originalMkdtemp=fs.mkdtempSync;const originalEnv={...process.env};const originalCwd=process.cwd();
try {
 for(const p of ['packages/main/src/core','packages/main/src/tasks'])fs.mkdirSync(join(root,p),{recursive:true});
 fs.writeFileSync(join(root,'package.json'),JSON.stringify({name:'proof-or-stop'}));
 fs.writeFileSync(join(root,'packages/main/package.json'),JSON.stringify({name:'@proof-or-stop/core',type:'module'}));
 fs.writeFileSync(join(root,'packages/main/tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'Node16',moduleResolution:'Node16',rootDir:'src',outDir:'dist',skipLibCheck:true},include:['src/**/*.ts']}));
 fs.writeFileSync(join(root,'packages/main/src/cli.ts'),"console.log('0.0.0'); export const actualCompilerInput = 17;\n");
 fs.writeFileSync(join(root,'packages/main/src/index.ts'),'export const coreFixture = 1;\n');
 fs.writeFileSync(join(root,'packages/main/src/extension-api.ts'),'export const extensionFixture = 1;\n');
 for(const name of ['utils','graph','lab']) {fs.mkdirSync(join(root,'packages',name,'src'),{recursive:true});fs.writeFileSync(join(root,'packages',name,'package.json'),JSON.stringify({name:'@proof-or-stop/'+name,type:'module',main:'dist/index.js'}));fs.writeFileSync(join(root,'packages',name,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'Node16',moduleResolution:'Node16',rootDir:'src',outDir:'dist',declaration:true,skipLibCheck:true},include:['src/**/*.ts']}));fs.writeFileSync(join(root,'packages',name,'src/index.ts'),'export const compilerFixture = 1;\n');}
 fs.mkdirSync(join(root,'packages/graph/scripts'));fs.writeFileSync(join(root,'packages/graph/scripts/build-web.mjs'),"import fs from 'node:fs';fs.mkdirSync('assets');fs.writeFileSync('assets/app.html','<!doctype html>');\n");
 fs.mkdirSync(join(root,'scripts'));fs.writeFileSync(join(root,'scripts/build-lock-target.mjs'),'export {};\n');
 fs.mkdirSync(join(root,'bin'));fs.writeFileSync(join(root,'bin/proof-or-stop.js'),"import '../packages/main/dist/cli.js';\n");fs.writeFileSync(join(root,'bin/bootstrap-runner.js'),'export {};\n');
 fs.writeFileSync(join(root,'packages/main/src/core/runtime.cjs'),'module.exports = 17;\n');
 fs.writeFileSync(join(root,'packages/main/src/tasks/runtime.cjs'),'module.exports = 18;\n');
 fs.writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',outDir:'packages/main/dist',managedReviewIsolation:{mode:'readonly-build',adapter:'prooforstop-main-v1'}}));


 const mode=process.argv.find(arg=>['missing-executable','malformed-auth'].includes(arg))??'missing-executable';
 fs.symlinkSync('/usr/bin/git',join(bin,'git'));fs.symlinkSync(process.execPath,join(bin,'node'));
 if(mode==='malformed-auth'){fs.writeFileSync(join(bin,'codex'),`#!${process.execPath}\nprocess.exit(99);\n`,{mode:0o755});fs.writeFileSync(join(fixtureCodexHome,'auth.json'),'{secret-fixture-broken');}
 else if(mode!=='missing-executable')throw Error('unknown mode');
 const {StoryStore}=await load('core/store.js');const {resetConfigCache}=await load('core/config.js');const {createCrossHostReviewHandlers}=await load('handlers/cross-host-review.js');
 const storyId='B-a808',store=new StoryStore(root);
 const config=JSON.parse(fs.readFileSync(join(root,'proof-or-stop.config.json'),'utf8'));Object.assign(config,{storyDir:'.proof-or-stop/story/actives',workflow:{profile:'balanced'},proofAdmissibility:{mode:'enforce',enforcedConsumers:['REVIEW']}});fs.writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));
 git(['init','-b','main']);git(['config','user.name','U08 Test']);git(['config','user.email','u08@example.test']);git(['add','.']);git(['commit','-m','isolated crosshost input']);git(['checkout','-b','story/'+storyId]);
 store.writeStory(storyId,{storyId,name:'crosshost-preflight',title:'Crosshost preflight',description:'Synthetic independent entry preflight witness',type:'feature',phase:'REVIEW',priority:'high',currentReviewRound:'2026-09-10T00:00:00.000Z',riskSignals:[],createdAt:'2026-09-10T00:00:00.000Z',events:[]});store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Synthetic input',context:'Bounded fixture',status:'done',startTime:null,endTime:null}]});
 const findings=join(base,'host-a.json');fs.writeFileSync(findings,'[]');git(['add','.']);git(['commit','-m','temporary review metadata']);
 process.chdir(root);resetConfigCache();process.env.PATH=bin;process.env.CODEX_HOME=fixtureCodexHome;
 fs.mkdtempSync=(prefix,...args)=>{if(String(prefix).includes('proof-or-stop-xhr-review-'))snapshotStarts++;return originalMkdtemp(prefix,...args);};syncBuiltinESMExports();
 const policy={schemaVersion:'lattice.dispatch_policy.v1',policy:'xhr-review-only',allowedHosts:['codex'],allowedPaths:['packages/main/src/'],deniedPaths:[],maxParallel:1,maxRuntimeMinutes:12,maxBudgetUSD:1,network:'none',envAllowlist:[],envDenylist:[],commandAllowlist:['codex exec -s read-only'],retryLimit:0,requireReceipt:true,requireReview:true,allowRealHostSubprocess:false,allowReviewOnlyRealHostSubprocess:true,allowAutoMerge:false,allowProductionDone:false,createdAt:'2026-09-10T00:00:00.000Z'};
 const handler=createCrossHostReviewHandlers({root,store,scanRoot:join(root,'packages/main')},{launchWorker:()=>{workerStarts++;throw Error('fixture unexpected worker startup');}});
 let failure;try{await handler.cross_host_review({storyId,policy,hostAFindingsFile:findings,detach:true,json:true});}catch(error){failure=error;}
 console.log(JSON.stringify({mode,snapshotStarts,workerStarts,error:String(failure)}));
 assert.equal(snapshotStarts,0,'handler must refuse before real snapshot creation');assert.equal(workerStarts,0);assert.match(String(failure),mode==='missing-executable'?/provider executable unavailable/:/credentials syntax invalid/);assert.doesNotMatch(String(failure),/secret-fixture-broken/);
 console.log('PASS actual crosshost handler '+mode+' zero snapshot and zero worker');
} finally {fs.mkdtempSync=originalMkdtemp;os.userInfo=originalUserInfo;syncBuiltinESMExports();process.chdir(originalCwd);for(const name of Object.keys(process.env))if(!(name in originalEnv))delete process.env[name];Object.assign(process.env,originalEnv);fs.rmSync(base,{recursive:true,force:true});}
