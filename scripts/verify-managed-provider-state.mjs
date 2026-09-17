import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=realpathSync(process.argv[2]??fileURLToPath(new URL('..',import.meta.url)));
const {preflightManagedProviderState}=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-review-provider-state.js')).href);
const root=realpathSync(mkdtempSync(join(tmpdir(),'managed-provider-state-')));
try {
 writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-key'}));
 writeFileSync(join(root,'config.toml'),'# Supported file store\n"cli_auth_credentials_store" = "file" # quoted TOML key\n');
 assert.equal(preflightManagedProviderState('codex',{CODEX_HOME:root}).host,'codex');
 writeFileSync(join(root,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id'}}));
 assert.equal(preflightManagedProviderState('codex',{CODEX_HOME:root}).host,'codex');
 writeFileSync(join(root,'settings.json'),'{}');
 assert.equal(preflightManagedProviderState('claude',{CLAUDE_CONFIG_DIR:root,ANTHROPIC_API_KEY:'synthetic-key'}).credentials,null);
 writeFileSync(join(root,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh'}}));
 assert.ok(preflightManagedProviderState('claude',{CLAUDE_CONFIG_DIR:root}).credentials);
 console.log('PASS supported file/token credentials, quoted file TOML/comments, Claude environment credentials');
 const grok=join(root,'grok');
 const fs=await import('node:fs');fs.mkdirSync(grok,{mode:0o700});
 fs.writeFileSync(join(grok,'auth.json'),JSON.stringify({'https://auth.x.ai::fixture':{key:'synthetic-access',auth_mode:'oidc',refresh_token:'synthetic-refresh',oidc_issuer:'https://auth.x.ai',oidc_client_id:'fixture',expires_at:'2099-01-01T00:00:00Z'}}),{mode:0o600});
 let state;
 try {state=preflightManagedProviderState('grok',{GROK_HOME:grok});}
 catch {assert.fail('ISOLATED_REVIEW_AUTH_RED: authenticated Grok file state must be supported without using the ambient home');}
 assert.equal(state.host,'grok');
 assert.equal(state.directory,grok);
 const api=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-review-provider-state.js')).href);
 const credentials=fs.readFileSync(join(grok,'auth.json'),'utf8');
 fs.writeFileSync(join(grok,'config.toml'),'[cli]\nuse_leader = true\nauto_update = true\n');
 const captured=api.captureManagedProviderState('grok',{GROK_HOME:grok});
 fs.writeFileSync(join(grok,'auth.json'),'{}');
 const cache=join(root,'cache');fs.mkdirSync(cache,{mode:0o700});
 const privateState=api.materializeManagedProviderState(cache,captured);
 assert.equal(fs.readFileSync(join(privateState.directory,'auth.json'),'utf8'),credentials,'snapshot must not reread changed credentials');
 assert.equal(fs.statSync(join(privateState.directory,'auth.json')).mode&0o777,0o600);
 assert.equal(fs.statSync(privateState.directory).mode&0o777,0o700);
 assert.match(fs.readFileSync(join(privateState.directory,'config.toml'),'utf8'),/use_leader = false/);
 assert.match(fs.readFileSync(join(grok,'config.toml'),'utf8'),/use_leader = true/,'original config unchanged');
 assert.equal(api.managedProviderStateEnvironment(privateState).GROK_HOME,privateState.directory);
 assert.equal(api.managedProviderStateEnvironment(privateState).GROK_DISABLE_AUTOUPDATER,'1');
 assert.match(fs.readFileSync(join(privateState.directory,'config.toml'),'utf8'),/auto_update = false/);
 for(const policy of ['requirements.toml','managed_config.toml']) {
   fs.writeFileSync(join(grok,policy),'# fixture policy');
   assert.throws(()=>api.captureManagedProviderState('grok',{GROK_HOME:grok}),/policy files require an explicit isolation adapter/);
   fs.unlinkSync(join(grok,policy));
 }
 assert.throws(()=>api.captureManagedProviderState('grok',{GROK_HOME:grok}),/supported nonempty/);
 fs.unlinkSync(join(grok,'auth.json'));
 assert.throws(()=>api.captureManagedProviderState('grok',{GROK_HOME:grok}),/requires an existing/);
 assert.equal(api.preflightManagedProviderState('grok',{GROK_HOME:grok,XAI_API_KEY:'synthetic-key'}).credentials,null);
 fs.symlinkSync(join(root,'auth.json'),join(grok,'auth.json'));
 assert.throws(()=>api.captureManagedProviderState('grok',{GROK_HOME:grok}),/bounded regular/);

 // Exercise the production fixed Keychain reader without touching actual login state.
 const cp=(await import('node:child_process')).default;
 const os=(await import('node:os')).default;
 const {syncBuiltinESMExports}=await import('node:module');
 const savedExec=cp.execFileSync,savedHome=os.homedir;
 const fakeHome=join(root,'home');fs.mkdirSync(join(fakeHome,'.claude'),{recursive:true});
 let keychainCalls=0;
 try {
   os.homedir=()=>fakeHome;
   cp.execFileSync=(command,argv,options)=>{
     assert.equal(command,'/usr/bin/security');
     assert.deepEqual(argv,['find-generic-password','-s','Claude Code-credentials','-w']);
     assert(options.timeout>0&&options.maxBuffer>0);keychainCalls++;
     return Buffer.from(JSON.stringify({claudeAiOauth:{accessToken:'fixture-access',refreshToken:'fixture-refresh'},mcpOAuth:{unrelated:'DO-NOT-COPY'}}));
   };
   syncBuiltinESMExports();
   if(process.platform==='darwin') {
     const snap=api.captureManagedProviderState('claude',{});
     const target=join(root,'claude-cache');fs.mkdirSync(target,{mode:0o700});
     const isolated=api.materializeManagedProviderState(target,snap);
     const bytes=fs.readFileSync(join(isolated.directory,'.credentials.json'),'utf8');
     assert.deepEqual(Object.keys(JSON.parse(bytes)),['claudeAiOauth']);
     assert(!bytes.includes('DO-NOT-COPY'));
     assert.equal(keychainCalls,1,'one capture must perform exactly one Keychain read');
     const calls=keychainCalls;
     assert.throws(()=>api.captureManagedProviderState('claude',{CLAUDE_CONFIG_DIR:grok}),/requires an existing/);
     assert.equal(keychainCalls,calls,'custom homes must never use another account Keychain');
     cp.execFileSync=()=>{throw new Error('SECRET-CREDENTIAL-ERROR');};syncBuiltinESMExports();
     assert.throws(()=>api.captureManagedProviderState('claude',{}),error=>/credential unavailable/.test(error.message)&&!String(error).includes('SECRET'));
     cp.execFileSync=()=>Buffer.from('{"claudeAiOauth":{}}');syncBuiltinESMExports();
     assert.throws(()=>api.captureManagedProviderState('claude',{}),/supported nonempty/);
     console.log('CLAUDE_KEYCHAIN_FIXTURE_PASS');
   } else console.log('CLAUDE_KEYCHAIN_FIXTURE_SKIPPED: macOS-specific adapter');
 } finally {cp.execFileSync=savedExec;os.homedir=savedHome;syncBuiltinESMExports();}
 const {FinalAssistantResultScanner,materializeHostRunLaunch}=await import(pathToFileURL(join(repo,'packages/main/dist/core/host-run.js')).href);
 const schema='fixture.review.v1',proposal={schemaVersion:schema,verdict:'pass'};
 const scanner=new FinalAssistantResultScanner('grok',4096,schema);
 scanner.push(JSON.stringify({type:'result',subtype:'success',structured_output:proposal})+'\n');scanner.flush();
 assert.equal(scanner.snapshot().result,JSON.stringify(proposal));
 const failed=new FinalAssistantResultScanner('grok',4096,schema);
 failed.push(JSON.stringify({type:'result',subtype:'error_during_execution',structured_output:proposal})+'\n');failed.flush();
 assert.equal(failed.snapshot().result,null);
 const duplicate=new FinalAssistantResultScanner('grok',4096,schema);
 const envelope=JSON.stringify({type:'result',subtype:'success',structured_output:proposal})+'\n';
 duplicate.push(envelope+envelope);duplicate.flush();assert.equal(duplicate.snapshot().count,2,'duplicate terminal proposals remain ambiguous');
 const contradictory=new FinalAssistantResultScanner('grok',4096,schema);
 contradictory.push(JSON.stringify({type:'result',subtype:'success',is_error:true,structured_output:proposal})+'\n');contradictory.flush();assert.equal(contradictory.snapshot().result,null);
 const oversize=new FinalAssistantResultScanner('grok',96,schema);
 oversize.push(JSON.stringify({type:'result',subtype:'success',structured_output:{...proposal,note:'x'.repeat(512)}})+'\n');oversize.flush();assert.equal(oversize.snapshot().truncated,true);
 const lateFailure=new FinalAssistantResultScanner('grok',4096,schema);lateFailure.push(envelope+JSON.stringify({type:'error',message:'fixture failure'})+'\n');lateFailure.flush();assert.equal(lateFailure.snapshot().result,null);
 const lateMessage=new FinalAssistantResultScanner('grok',4096,schema);
 lateMessage.push(envelope+JSON.stringify({type:'assistant',message:'late content'})+'\n');lateMessage.flush();
 assert.equal(lateMessage.snapshot().result,null);assert(lateMessage.snapshot().count>1);
 const {parseLiveProviderUsage}=await import(pathToFileURL(join(repo,'packages/main/dist/core/usage-ledger/dispatch-usage.js')).href);
 const usage=parseLiveProviderUsage('grok',JSON.stringify({type:'result',usage:{input_tokens:12,output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:2}}));
 assert.equal(usage.provider,'grok');assert.equal(usage.tokens,21);
 assert.equal(parseLiveProviderUsage('grok',JSON.stringify({type:'result'})),null);
 const {ReviewerBatchAdmitArgsSchema}=await import(pathToFileURL(join(repo,'packages/main/dist/core/reviewer-batch-admit-schema.js')).href);
 assert.equal(ReviewerBatchAdmitArgsSchema.parse({storyId:'fixture',assignments:[{lane:'proof-or-stop-review-quality',kind:'managed',host:'grok'}]}).assignments[0].host,'grok');
 const {canonicalReviewHostLauncherSpec,classifyReviewHostLauncher}=await import(pathToFileURL(join(repo,'packages/main/dist/core/host-execution-readiness.js')).href);
 assert.equal(classifyReviewHostLauncher('grok',canonicalReviewHostLauncherSpec('grok').launcherArgv).launcherOk,true);
 const refusal=/grok supports only --managedReview \/ acceptance_amendment_review/;
 const {runHostRun}=await import(pathToFileURL(join(repo,'packages/main/dist/core/host-run.js')).href);
 const {submitManagedHostRun}=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-host-run.js')).href);
 const {createHostRunHandlers}=await import(pathToFileURL(join(repo,'packages/main/dist/handlers/host-run.js')).href);
 const handlers=createHostRunHandlers({root,scanRoot:root,store:{}});
 for(const managedDispatch of [false,true]) {
   await assert.rejects(()=>handlers.host_run({host:'grok',prompt:'fixture',agentType:'fixture',managedDispatch}),refusal);
   const profile=managedDispatch?'managed_dispatch':undefined;
   await assert.rejects(()=>submitManagedHostRun({host:'grok',profile}),refusal);
   await assert.rejects(()=>runHostRun({host:'grok',launchProfile:profile}),refusal);
   assert.throws(()=>materializeHostRunLaunch({host:'grok',launchProfile:profile}),refusal);
 }
 await assert.rejects(()=>runHostRun({host:'grok',launchProfile:'managed_reviewer'}),/grok requires a sealed managed readonly layout/);
 const unconfigured={host:'grok',profile:'managed_reviewer',root,cwd:root,isolateManagedReview:true,
   promptText:'fixture',phase:'REVIEW',storyId:'B-fixture',reviewRunId:'B-fixture:RR-001',
   agentType:'proof-or-stop-review-quality',lane:'proof-or-stop-review-quality',projectRootHash:'fixture',
   reviewBinding:{headHash:'fixture',materialHash:'fixture',storyFilesHash:'fixture',promptHash:'fixture',managedPromptDigest:'sha256:'+ 'a'.repeat(64)}};
 const beforeRefusal=fs.readdirSync(root).sort();
 await assert.rejects(()=>submitManagedHostRun(unconfigured),/grok requires configured managedReviewIsolation/);
 assert.deepEqual(fs.readdirSync(root).sort(),beforeRefusal,'unconfigured Grok refuses before creating run artifacts');
 fs.writeFileSync(join(root,'proof-or-stop.config.json'),'{}');
 await assert.rejects(()=>submitManagedHostRun(unconfigured),/grok requires configured managedReviewIsolation/);
 fs.unlinkSync(join(root,'proof-or-stop.config.json'));
 const launch=materializeHostRunLaunch({host:'grok' ,promptText:'fixture-private-prompt',cwd:root,root,
   launchProfile:'managed_reviewer',managedRunId:'fixture-grok-review',model:'fixture-model',reasoningEffort:'high',
   storyId:'B-fixture',reviewRunId:'B-fixture:RR-001',lane:'proof-or-stop-review-quality',agentType:'proof-or-stop-review-quality'});
 try {
   assert.equal(launch.command,'grok');assert(!launch.argv.includes('fixture-private-prompt'));
   const index=launch.argv.indexOf('--prompt-file');assert(index>=0);
   assert.equal(index,launch.argv.length-2,'prompt file flag stays paired with its path');
   for(const [flag,value] of [['--model','fixture-model'],['--reasoning-effort','high'],['--permission-mode','bypassPermissions']]) {
     const position=launch.argv.indexOf(flag);assert(position>=0&&position+1<index);assert.equal(launch.argv[position+1],value);
   }
   const schemaIndex=launch.argv.indexOf('--json-schema');assert(schemaIndex>=0&&schemaIndex+1<index);
   assert.equal(JSON.parse(launch.argv[schemaIndex+1]).type,'object');
   assert.equal(fs.readFileSync(launch.argv[index+1],'utf8'),'fixture-private-prompt');
   assert.equal(fs.statSync(launch.argv[index+1]).mode&0o777,0o600);
 } finally {launch.cleanup();}
 console.log('ISOLATED_REVIEW_AUTH_PASS: private Claude/Grok authentication, no ambient mutation, protected prompt and terminal-only result');
} finally {rmSync(root,{recursive:true,force:true});}
