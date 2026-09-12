import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareVerification } from './verification-subprocess-budget.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const spawnSync = prepareVerification(repo);
const root=mkdtempSync(join(tmpdir(),'cli-audit-final-'));const groups=[];const measurements={};
const check=async(id,fn)=>{try{await fn();groups.push({id,pass:true});}catch(e){groups.push({id,pass:false,error:e.message});}};
try{
  await check('one-hardening-execution-per-contract',()=>{
    const source=readFileSync(join(repo,'scripts/verify-process-fact-contract.mjs'),'utf8');
    const count=[...source.matchAll(/execFileSync\(process\.execPath, \[join\(root, 'scripts\/verify-cli-audit-hardening\.mjs'\)\]/g)].length;
    measurements.hardeningContractInvocations=count;assert.equal(count,1,'contract must schedule the same proof exactly once');
  });
  await check('heartbeat-preserves-real-runtime-version-refusal',async()=>{
    const {runCodexAdapterChecks}=await import(join(repo,'packages/main/dist/core/codex-adapter-checks.js'));
    const pkg=join(root,'installation/packages/main'),bin=join(root,'bin'),project=join(root,'project');
    mkdirSync(join(pkg,'dist/core'),{recursive:true});mkdirSync(bin);mkdirSync(project);
    for(const file of ['runtime-package-version.js','proof-or-stop-brand.js'])cpSync(join(repo,'packages/main/dist/core',file),join(pkg,'dist/core',file));
    writeFileSync(join(project,'package.json'),JSON.stringify({name:'isolated-heartbeat',type:'module'}));
    const executable=join(bin,'proof-or-stop');
    writeFileSync(executable,`#!${process.execPath}\nimport(${JSON.stringify(join(pkg,'dist/core/runtime-package-version.js'))}).then(m=>{try{m.assertRuntimePackageVersion();}catch(e){process.stderr.write(e.message+'\\n');process.exitCode=1;}});\n`);chmodSync(executable,0o755);
    const previousPath=process.env.PATH;const rows=[];
    try{
      process.env.PATH=bin+':'+(previousPath??'');
      for(const [version,code] of [['999.91.0','CLI_RUNTIME_VERSION_MISMATCH'],[null,'CLI_RUNTIME_VERSION_METADATA_INVALID']]) for(const warning of ['', 'Node ExperimentalWarning: fixture notice\n']) for(const outputStyle of ['message','error-object']){
        writeFileSync(join(pkg,'package.json'),JSON.stringify({type:'module',version}));
        writeFileSync(executable,`#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(warning)});import(${JSON.stringify(join(pkg,'dist/core/runtime-package-version.js'))}).then(m=>{try{m.assertRuntimePackageVersion();}catch(e){${outputStyle==='error-object'?'console.error(e);':"process.stderr.write(e.message+'\\n');"}process.exitCode=1;}});\n`);
        const result=runCodexAdapterChecks(project,{executeGlobalHeartbeat:true,executeLocalHeartbeat:false,timeoutMs:5000});
        const row=result.checks.find(c=>c.id==='global-fallback-heartbeat');assert.ok(row);assert.equal(row.status,'fail');rows.push(row);
        assert.match(row.detail,/\[heartbeat_runtime_version_mismatch\]/);assert.ok(row.detail.includes(code+':'));
        assert.doesNotMatch(row.detail,/heartbeat command failed:/);assert.match(row.detail,/installation/i);
      }
      writeFileSync(executable,`#!${process.execPath}\nprocess.stderr.write('ordinary fixture failure\\n');process.exitCode=17;\n`);
      const broken=runCodexAdapterChecks(project,{executeGlobalHeartbeat:true,executeLocalHeartbeat:false,timeoutMs:5000}).checks.find(c=>c.id==='global-fallback-heartbeat');
      assert.equal(broken.status,'fail');assert.match(broken.detail,/heartbeat command failed: ordinary fixture failure/);assert.doesNotMatch(broken.detail,/heartbeat_runtime_version_mismatch/);
    }finally{if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;measurements.heartbeatRows=rows;}
  });
  await check('readonly-prompt-v1-has-body-and-environment',async()=>{
    const project=join(root,'prompt');mkdirSync(project);
    const config={...JSON.parse(readFileSync(join(repo,'proof-or-stop.config.json'))),scanRoot:'.',rootDir:'src',outDir:'dist',testsDir:'tests',fixturesDir:'tests/fixtures',storyDir:'.proof-or-stop/story/actives'};
    writeFileSync(join(project,'proof-or-stop.config.json'),JSON.stringify(config));
    for(const args of [['init','-q','-b','main'],['config','user.name','Audit fixture'],['config','user.email','audit@example.invalid'],['add','.'],['commit','-qm','seed reader context']]) {
      const result=spawnSync('git',args,{cwd:project,encoding:'utf8',timeout:15000});assert.equal(result.status,0,'SETUP_GIT: '+result.stderr);
    }
    const {StoryStore}=await import(join(repo,'packages/main/dist/core/store.js'));
    const {createAgentPromptHandlers}=await import(join(repo,'packages/main/dist/handlers/agent-prompt.js'));
    const {resolvePromptRoleBody}=await import(join(repo,'packages/main/dist/core/prompt-role-contract-registry.js'));
    const {captureKnownExecutionEnvironment}=await import(join(repo,'packages/main/dist/core/prompt-envelope.js'));
    const store=new StoryStore(project),sid='B-v1-reader',role='proof-or-stop-review-story-init';
    store.writeStory(sid,{storyId:sid,name:sid,title:'Reader response control',description:'Isolated diagnostic',phase:'INIT',type:'chore',priority:'medium',createdAt:new Date().toISOString(),events:[]});store.writeChecklist(sid,{items:[]});
    const body=JSON.parse(createAgentPromptHandlers({store,root:project,scanRoot:project}).agent_prompt({role,storyId:sid,readOnly:true,format:'json'}));
    measurements.readerFields=Object.keys(body);assert.equal(body.schemaVersion,'proof-or-stop.agent-prompt-response.v1');
    assert.equal(body.roleBodyDigest,resolvePromptRoleBody(role,config.promptEnvelope).bodyDigest);
    assert.deepEqual(body.knownExecutionEnvironment,captureKnownExecutionEnvironment());assert.equal(body.envelope,null);assert.equal(body.canMintReviewEvidence,false);
  });
  console.log(JSON.stringify({groups,measurements,boundary:'Heartbeat uses the real runtime guard in an isolated installation and the production adapter checker. No successful heartbeat or adapter health is fabricated.'},null,2));
  if(groups.some(g=>!g.pass)){console.error('CLI_AUDIT_FINAL_RED');process.exitCode=1;}else console.log('CLI_AUDIT_FINAL_GREEN');
}finally{rmSync(root,{recursive:true,force:true});}
