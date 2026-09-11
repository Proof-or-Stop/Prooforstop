import assert from 'node:assert/strict';
import { LAB_AUDIT_SCHEMA, developerHost, parseAuditResult, auditIsFresh } from './lab-audit.mjs';
assert.throws(()=>developerHost('claude',{CODEX_THREAD_ID:'x'}),/conflicts/);
assert.throws(()=>developerHost(undefined,{}),/declared/);
const binding={schemaVersion:LAB_AUDIT_SCHEMA,labName:'fixture',developerHost:'codex',auditorHost:'claude',head:'a',base:'b',inputDigest:'c',configDigest:'e',developerVendor:'openai',auditorVendor:'anthropic',runId:'d'};
const proposal={...binding,decision:'pass',summary:'Synthetic test protocol result with explicit bindings.',readRefs:['source.ts'],findings:[]};
const event=p=>JSON.stringify({type:'result',subtype:'success',structured_output:p});
assert.equal(parseAuditResult(event(proposal),'claude-jsonl',binding).decision,'pass');
for(const invalid of [{...proposal,head:'stale'},{...proposal,extra:true},{...proposal,findings:[{severity:'low',file:'source.ts',problem:'defect',fix:'repair'}]}])assert.throws(()=>parseAuditResult(event(invalid),'claude-jsonl',binding));
assert.throws(()=>parseAuditResult(event(proposal)+'\n'+event(proposal),'claude-jsonl',binding));
const codex=p=>JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(p)}});
assert.throws(()=>parseAuditResult(codex(proposal)+'\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'later prose'}}),'codex-jsonl',binding),/exactly one final Codex proposal/);
assert.equal(parseAuditResult(codex(proposal),'codex-jsonl',binding).decision,'pass');
assert.throws(()=>parseAuditResult(event(proposal),'unknown-jsonl',binding),/Unsupported Lab audit protocol/);
const processFacts={exitCode:0,replacementSafe:true,closeObserved:true,processCleanup:{reaped:true,residualProcessGroup:false}};
assert.equal(auditIsFresh({...proposal,process:processFacts},binding),true);
assert.equal(auditIsFresh({...proposal,process:{...processFacts,replacementSafe:false}},binding),false);
assert.equal(auditIsFresh({...proposal,process:processFacts},{...binding,head:'changed'}),false);
console.log('LAB_AUDIT_CONTRACT PASS strict output, stale bindings, duplicates and cleanup');

const {selectAuditor}=await import('./lab-audit-providers.mjs');
const adapter={id:'grok',vendor:'xai',command:'grok-audit-adapter',argv:['--schema','{schema}'],protocol:'lab-json'};
assert.equal(selectAuditor('codex',{adapters:[adapter],preferredAuditor:'grok'},()=>true).auditor.vendor,'xai');
assert.equal(selectAuditor('grok',{adapters:[adapter]},()=>true).auditor.vendor,'openai');
assert.throws(()=>selectAuditor('codex',{adapters:[{...adapter,vendor:'openai'}],preferredAuditor:'grok'},()=>true),/different vendor/);
assert.throws(()=>selectAuditor('codex',{},()=>false),/available/);
assert.equal(parseAuditResult(JSON.stringify(proposal),'lab-json',binding).decision,'pass');
console.log('LAB_AUDIT_VENDOR PASS third-vendor adapter, same-vendor rejection and unavailable providers');
const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
const {auditInput}=await import('./lab-audit.mjs');
const repo=mkdtempSync(join(tmpdir(),'lab-audit-input-'));
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  git('init','-b','main');git('config','user.name','Lab fixture');git('config','user.email','lab@example.invalid');
  writeFileSync(join(repo,'sample.txt'),'baseline');git('add','.');git('commit','-m','baseline');const base=git('rev-parse','HEAD');
  writeFileSync(join(repo,'sample.txt'),'literal \\u0000 in source');git('add','.');git('commit','-m','literal escape');
  assert.doesNotThrow(()=>auditInput(repo,base,git('rev-parse','HEAD')));
  writeFileSync(join(repo,' leading-space.txt'),'exact path content');git('add','.');git('commit','-m','whitespace path');
  const spaceHead=git('rev-parse','HEAD');
  const spaceInput=auditInput(repo,base,spaceHead);
  assert.equal(spaceInput.files.find(f=>f.path===' leading-space.txt').content,'exact path content');
  assert.equal(auditInput(repo,base,spaceHead),spaceInput,'Immutable inputs should be reused within the process');
  writeFileSync(join(repo,'sample.txt'),'\ufeffBOM preserved');git('add','.');git('commit','-m','utf8 bom control');
  assert.equal(auditInput(repo,base,git('rev-parse','HEAD')).files.find(f=>f.path==='sample.txt').content,'\ufeffBOM preserved');
  const large='x'.repeat(2*1024*1024+128);
  writeFileSync(join(repo,'sample.txt'),large);git('add','.');git('commit','-m','large source control');
  assert.equal(auditInput(repo,base,git('rev-parse','HEAD')).files.find(f=>f.path==='sample.txt').content,large);
  writeFileSync(join(repo,'sample.txt'),'actual \0 byte');git('add','.');git('commit','-m','binary control');
  assert.throws(()=>auditInput(repo,base,git('rev-parse','HEAD')),/bounded text/);
  writeFileSync(join(repo,'sample.txt'),Buffer.from([0x63,0x61,0x66,0xe9]));git('add','.');git('commit','-m','invalid utf8 control');
  assert.throws(()=>auditInput(repo,base,git('rev-parse','HEAD')),/bounded text contract: invalid UTF-8/);
  console.log('LAB_AUDIT_INPUT PASS literal escapes accepted, actual binary refused');
} finally {rmSync(repo,{recursive:true,force:true});}

const {runCustomAuditAdapter}=await import('./lab-audit.mjs');
for(const stage of ['before-spawn','after-spawn']) {
  let released=0;
  const admissionApi={acquireProviderProcessAdmission:()=>({admitted:true}),transferProviderProcessAdmissionToProvider:()=>true,releaseProviderProcessAdmission:()=>released++};
  await assert.rejects(()=>runCustomAuditAdapter({command:'fixture',env:{}},'/tmp',new AbortController(),{admissionApi,runner:async plan=>{if(stage==='after-spawn')plan.onSpawn({pid:1});throw new Error('fixture spawn failure');}}),/fixture spawn failure/);
  assert.equal(released,stage==='before-spawn'?1:0);
}
console.log('LAB_AUDIT_ADMISSION PASS pre-spawn release and unknown-child retention');
