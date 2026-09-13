/** Disposable signed fixtures are synthetic authorization, never operator acknowledgements. */
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {canonicalDigest} from '../packages/main/dist/core/authority-signing.js';
import {signValidationArtifact} from '../packages/main/dist/core/validation-artifact-signing.js';
import {createAcceptanceAmendmentController} from '../packages/main/dist/core/acceptance-amendment-journal.js';
import {deriveAcceptanceAmendment} from '../packages/main/dist/core/acceptance-amendment.js';
import {evaluateStoryScopeBudget, readStoryScopeBudget} from '../packages/main/dist/core/story-scope-budget.js';
import {createChecklistHandlers} from '../packages/main/dist/handlers/checklist.js';
import {acquireOwnerLease} from '../packages/main/dist/core/story-owner-lease.js';
import {hasMechanicalExecutionAuthority} from '../packages/main/dist/core/verification-receipt-authority.js';
import {SCOPE_BUDGET_DECISION_RUNTIME_POLICY as runtimePolicy} from '../packages/main/dist/core/runtime-fact-registry.js';
import {base,delta} from './verify-acceptance-amendment-delta.mjs';

const root=mkdtempSync(join(tmpdir(),'scope-approval-continuity-')), priorCwd=process.cwd();
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
const signed=claims=>({...claims,signature:signValidationArtifact(claims,root)});
const storyId=base.storyId;
try {
  process.chdir(root);
  git('init','-q','-b','main');git('config','user.name','Synthetic approval fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'.gitignore'),'.proof-or-stop/keys/\n**/*.lock/\n**/owner-lease.json\n.lattice/\n');
  mkdirSync(join(root,'src'));mkdirSync(join(root,'tests'));
  writeFileSync(join(root,'src/add.ts'),'export const add=(a,b)=>a+b;\n');
  writeFileSync(join(root,'tests/add.test.ts'),'// Declaration used by this isolated scope fixture.\n');
  writeFileSync(join(root,'verify.cjs'),"require('node:assert/strict').equal(require('./src/add.ts').add(2,3),5);console.log('CONTINUITY_REAL_EXECUTION_PASS');\n");
  const config={scanRoot:'.',rootDir:'.',storyDir:'.proof-or-stop/story/actives',validate:{commands:['node verify.cjs','node --help']},
    storyScopeBudget:{schemaVersion:'story-scope-budget.v1',mode:'enforce',
      limits:{responsibilityDomains:10,hostAdapters:10,processFacts:100,publicCommands:100,acceptanceTopology:1,devScopeDelta:100,validationGroups:100},
      responsibilities:[{id:'addition',paths:['src/**','tests/**'],hostAdapters:[],validationGroups:['original']}],
      validationGroups:[{id:'original',commandLabels:['node verify.cjs']}]}};
  const setConfig=value=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(value));resetConfigCache();};
  setConfig(config);git('add','.');git('commit','-qm','isolated repository');git('switch','-qc',`story/${storyId}`);
  const store=new StoryStore(root),now=new Date().toISOString();
  store.writeStory(storyId,{storyId,name:storyId,title:'Synthetic approval continuity witness',phase:'DEV',priority:'medium',createdAt:now,events:[]});
  acquireOwnerLease(store.storyDirPath(storyId),{command:'isolated-continuity-fixture',cwd:root});
  store.writeChecklist(storyId,base.checklist);store.writeScopeContract(storyId,base.scope);store.writeProofStoryContract(storyId,base.proofStory);
  const controller=createAcceptanceAmendmentController(store,root);
  const proposal=controller.propose({storyId,amendmentId:'AM-continuity',delta,submitterSessionId:'synthetic-fixture'});
  const approved=deriveAcceptanceAmendment(base,delta);
  // Only this disposable fixture uses its local signing key to model already-applied authority.
  // It never simulates TTY, clears agent identity, calls the real approval issuer, or claims vendor review.
  const {signature:unused,...entryClaims}=proposal;
  const amendment=signed({...entryClaims,state:'APPROVED'});
  const journal=store.readAcceptanceAmendments(storyId);
  const {signature:oldJournalSignature,...journalClaims}=journal;
  store.writeAcceptanceAmendments(storyId,signed({...journalClaims,entries:[amendment]}));
  store.writeChecklist(storyId,approved.checklist);store.writeScopeContract(storyId,approved.scope);store.writeProofStoryContract(storyId,approved.proofStory);
  const result=evaluateStoryScopeBudget(approved,config),growth=evaluateStoryScopeBudget(approved,config,base);
  assert.equal(result.status,'decision_required');
  const approval=signed({schemaVersion:'story-scope-budget-approval.v1',kind:'human-large-story',storyId,
    bindingDigest:growth.bindingDigest,resultingScopeDigest:result.bindingDigest,
    reason:'Synthetic fixture authorization binds this exact scope; no actual operator acknowledgement is represented.',
    issuedAt:now,expiresAt:new Date(Date.parse(now)+3600000).toISOString(),channel:'interactive-operator'});
  store.writeScopeBudgetDecisions(storyId,signed({schemaVersion:'story-scope-budget-decisions.v1',storyId,decisions:[approval]}));
  git('add','.');git('commit','-qm','publish synthetic signed applied scope approval');
  const approvalCommit=git('rev-parse','HEAD');
  const approvalPath=store.storyFilePath(storyId,'scope-budget-decisions.json'),approvalBytes=readFileSync(approvalPath);
  const report=()=>{const r=readStoryScopeBudget(store,root,storyId);assert.deepEqual(readFileSync(approvalPath),approvalBytes,'budget reads cannot rewrite authorization');return r;};
  assert.equal(report().status,'approved_large_story','exact signed binding remains accepted');
  assert.deepEqual(store.readScopeContract(storyId),approved.scope,'fixture applied scope must round-trip exactly');
  await createChecklistHandlers({root,scanRoot:root,store,log(){}}).verification_evidence_add({storyId,itemId:'CHK-006',intentRef:'CHK-006:happy:0',kind:'integration_test',command:'node verify.cjs',selector:'CONTINUITY_REAL_EXECUTION_PASS',note:'Real disposable Node execution provides the first immutable intent pin.'});
  const pinned=store.readChecklist(storyId),item=pinned.items.find(i=>i.id==='CHK-006');
  assert(item.verificationEvidence.some(e=>hasMechanicalExecutionAuthority(store,storyId,item,e)),'first pin requires an actual V5 execution');
  git('add','.');git('commit','-qm','publish genuine first-pin execution');
  const pinOnly=report();
  const additive=structuredClone(config);additive.validate.commands.unshift('node --version');setConfig(additive);
  const combined=report();
  store.writeChecklist(storyId,approved.checklist);const commandsOnly=report();
  store.writeChecklist(storyId,pinned);
  console.log('SCOPE_APPROVAL_CONTINUITY_OBSERVATIONS '+JSON.stringify({pinOnly:pinOnly.status,commandsOnly:commandsOnly.status,combined:combined.status}));
  for(const [label,r] of Object.entries({pinOnly,commandsOnly,combined}))assert.equal(r.status,'approved_large_story',`SCOPE_APPROVAL_BOOKKEEPING_INVALIDATION: ${label} must retain the original authenticated scope approval`);
  assert.equal(canonicalDigest(approval),canonicalDigest(store.readScopeBudgetDecisions(storyId).decisions[0]));
  const negativeLabels=[];
  const refused=(label)=>{assert.notEqual(report().status,'approved_large_story',label);negativeLabels.push(label);};
  const withChecklist=(label,mutate)=>{const changed=structuredClone(pinned);mutate(changed);store.writeChecklist(storyId,changed);try{refused(label);}finally{store.writeChecklist(storyId,pinned);}};
  withChecklist('changed requirement',c=>{c.items[0].title+=' changed';});
  withChecklist('changed declared file',c=>{c.items[5].files.modify.push('src/other.ts');});
  withChecklist('withdrawn requirement',c=>{c.items[0].status='withdrawn';});
  withChecklist('changed first pin command',c=>{c.items[5].verificationIntent.happy[0].verification.command='node --version';});
  withChecklist('changed first pin selector',c=>{c.items[5].verificationIntent.happy[0].verification.selector='different';});
  const withConfig=(label,mutate)=>{const changed=structuredClone(additive);mutate(changed);setConfig(changed);try{refused(label);}finally{setConfig(additive);}};
  withConfig('removed original command',c=>{c.validate.commands.splice(1,1);});
  withConfig('modified original command',c=>{c.validate.commands[1]='node different.cjs';});
  withConfig('reordered original commands',c=>{[c.validate.commands[1],c.validate.commands[2]]=[c.validate.commands[2],c.validate.commands[1]];});
  withConfig('explicit lookalike label changes raw entry',c=>{c.validate.commands[1]={command:'node',args:['verify.cjs'],label:'configured validate.commands[1]'};});
  withConfig('duplicate execution tuple under a new ID',c=>{c.validate.commands.push({id:'duplicate-original',label:'different label',command:'node',args:['verify.cjs']});});
  withConfig('ambiguous group label',c=>{c.validate.commands.push({id:'ambiguous-group',label:'node verify.cjs',command:'node',args:['--experimental-default-type=module','--version']});});
  withConfig('changed validation defaults',c=>{c.validate.dynamic={policyDefaults:{assurance:'advisory'}};});
  withConfig('changed budget limit',c=>{c.storyScopeBudget.limits.acceptanceTopology=2;});
  withConfig('unknown scope map',c=>{c.storyScopeBudget.responsibilities[0].paths=['unmapped/**'];});
  const changedScope=structuredClone(approved.scope);changedScope.explicitExcludes.push('new-exclusion/**');store.writeScopeContract(storyId,changedScope);
  try{refused('changed scope exclusions');}finally{store.writeScopeContract(storyId,approved.scope);}
  const changedTopology=structuredClone(approved.proofStory);changedTopology.acceptanceBindings[0].milestoneIds.push('changed');store.writeProofStoryContract(storyId,changedTopology);
  try{refused('changed topology');}finally{store.writeProofStoryContract(storyId,approved.proofStory);}
  const originalNow=Date.now;
  try{Date.now=()=>Date.parse(approval.expiresAt)+1;refused('expired original approval');}finally{Date.now=originalNow;}
  const decisionJournal=store.readScopeBudgetDecisions(storyId),altered=structuredClone(decisionJournal);altered.decisions[0].reason+=' forged';store.writeScopeBudgetDecisions(storyId,altered);
  try{assert.equal(readStoryScopeBudget(store,root,storyId).status,'unknown');negativeLabels.push('forged original approval');}finally{store.writeScopeBudgetDecisions(storyId,decisionJournal);}
  const signedAmendmentJournal=store.readAcceptanceAmendments(storyId),badAmendment=structuredClone(signedAmendmentJournal);badAmendment.entries[0].base.checklist.items[0].title+=' forged';store.writeAcceptanceAmendments(storyId,badAmendment);
  try{refused('forged amendment base');}finally{store.writeAcceptanceAmendments(storyId,signedAmendmentJournal);}
  assert.notEqual(readStoryScopeBudget(store,root,storyId,{...approved,checklist:pinned}).status,'approved_large_story','projected next scope never inherits compatibility');
  negativeLabels.push('projected amendment next is not current-scope continuity');
  const withGitObserver=(label,observe)=>{
    const original=child.execFileSync;
    child.execFileSync=function(file,args,options){const override=observe(file,args,options,original);return override===undefined?Reflect.apply(original,this,[file,args,options]):override;};
    syncBuiltinESMExports();
    try{refused(label);}finally{child.execFileSync=original;syncBuiltinESMExports();}
  };
  let expiryTriggered=false,virtualNow=Date.parse(approval.expiresAt)-1000;
  try {
    Date.now=()=>virtualNow;
    withGitObserver('expiry during historical proof is rechecked',(file,args)=>{
      if(file==='git'&&args[0]==='log'){expiryTriggered=true;virtualNow=Date.parse(approval.expiresAt)+1;}
    });
    assert(expiryTriggered,'expiry control must enter history with initially valid approval');
  }finally{Date.now=originalNow;}
  let timeBoundTriggered=false;virtualNow=originalNow();
  try {
    Date.now=()=>virtualNow;
    withGitObserver('aggregate proof time bound',(file,args)=>{
      if(file==='git'&&args[0]==='log'){timeBoundTriggered=true;virtualNow+=runtimePolicy.continuityTotalMs+1;}
    });
    assert(timeBoundTriggered);
  }finally{Date.now=originalNow;}
  withGitObserver('missing historical approval publication',(file,args)=>file==='git'&&args[0]==='log'&&args.at(-1).endsWith('scope-budget-decisions.json')?'':undefined);
  withGitObserver('oversized historical publication inventory',(file,args)=>file==='git'&&args[0]==='log'?
    Array.from({length:runtimePolicy.continuityHistoryCommits+1},(_,i)=>i.toString(16).padStart(40,'0')).join('\n'):undefined);
  let configDrifted=false;
  try {
    withGitObserver('configuration changes during proof',(file,args)=>{
      if(file==='git'&&args[0]==='log'&&!configDrifted){configDrifted=true;const changed=structuredClone(additive);changed.validate.extra='concurrent change';setConfig(changed);}
    });
    assert(configDrifted);
  }finally{setConfig(additive);}
  let headDrifted=false;
  withGitObserver('HEAD changes during proof',(file,args,options,original)=>{
    if(file==='git'&&args[0]==='log'&&!headDrifted){headDrifted=true;original('git',['commit','--allow-empty','-qm','synthetic concurrent HEAD move'],{cwd:root,stdio:'pipe'});}
  });
  assert(headDrifted);
  assert.equal(report().status,'approved_large_story','a stable subsequent read can reconstruct current authority');
  const staleEvidence=structuredClone(pinned);staleEvidence.items[5].verificationEvidence[0].receipt.selectorMatched=false;store.writeChecklist(storyId,staleEvidence);
  try {
    assert.equal(report().status,'approved_large_story','scope acknowledgement is separate from current execution validity');
    assert.equal(hasMechanicalExecutionAuthority(store,storyId,staleEvidence.items[5],staleEvidence.items[5].verificationEvidence[0]),false,'compatibility cannot repair forged current execution evidence');
  }finally{store.writeChecklist(storyId,pinned);}
  // Every history mutation below is confined to this disposable Git repository.
  setConfig(config);git('add','.');if(git('diff','--cached','--name-only'))git('commit','-qm','restore witness after read-only negative controls');
  git('switch','-qc','witness/forged-first-pin',approvalCommit);
  const forgedPin=structuredClone(pinned);forgedPin.items[5].verificationEvidence[0].receipt.selectorMatched=false;store.writeChecklist(storyId,forgedPin);
  git('add','.');git('commit','-qm','synthetic unauthenticated first pin');
  try{refused('unauthenticated historical first pin');}finally{git('switch','-q',`story/${storyId}`);}
  git('switch','-qc','witness/changed-first-pin-semantics',approvalCommit);
  const differentMeaning=structuredClone(approved.checklist);differentMeaning.items[5].verificationIntent.happy[0].desc='A different unapproved requirement is being pinned';store.writeChecklist(storyId,differentMeaning);
  await createChecklistHandlers({root,scanRoot:root,store,log(){}}).verification_evidence_add({storyId,itemId:'CHK-006',intentRef:'CHK-006:happy:0',kind:'integration_test',command:'node verify.cjs',selector:'CONTINUITY_REAL_EXECUTION_PASS',note:'Real execution for a deliberately altered disposable intent meaning.'});
  const differentPinned=store.readChecklist(storyId),differentItem=differentPinned.items[5];
  assert(differentItem.verificationEvidence.some(e=>hasMechanicalExecutionAuthority(store,storyId,differentItem,e)),'semantic laundering control uses authentic execution');
  git('add','.');git('commit','-qm','genuine execution for altered synthetic intent');
  differentPinned.items[5].verificationIntent.happy[0].desc=approved.checklist.items[5].verificationIntent.happy[0].desc;store.writeChecklist(storyId,differentPinned);
  git('add','.');git('commit','-qm','restore approved wording while retaining different-meaning pin');
  try{refused('authentic first pin for altered semantics cannot be restored into approval');}finally{git('switch','-q',`story/${storyId}`);}
  git('switch','-qc','witness/originally-approved-pin',approvalCommit);
  const pinnedBase=structuredClone(base);pinnedBase.checklist.items[0].verificationIntent.happy[0].verification=structuredClone(pinned.items[5].verificationIntent.happy[0].verification);
  const initiallyPinned=deriveAcceptanceAmendment(pinnedBase,delta);
  const pinnedEntry=signed({...entryClaims,base:pinnedBase,baseDigest:canonicalDigest(pinnedBase),state:'APPROVED',nextDigest:canonicalDigest(initiallyPinned),amendmentDigest:canonicalDigest({storyId,baseDigest:canonicalDigest(pinnedBase),delta})});
  store.writeAcceptanceAmendments(storyId,signed({...journalClaims,entries:[pinnedEntry]}));
  store.writeChecklist(storyId,initiallyPinned.checklist);
  const {signature:oldApprovalSignature,...approvalClaims}=approval;
  const pinnedApproval=signed({...approvalClaims,bindingDigest:evaluateStoryScopeBudget(initiallyPinned,config,pinnedBase).bindingDigest,resultingScopeDigest:evaluateStoryScopeBudget(initiallyPinned,config).bindingDigest});
  store.writeScopeBudgetDecisions(storyId,signed({schemaVersion:'story-scope-budget-decisions.v1',storyId,decisions:[pinnedApproval]}));
  git('add','.');git('commit','-qm','synthetic original approval already contains an immutable pin');
  assert.equal(readStoryScopeBudget(store,root,storyId).status,'approved_large_story');
  setConfig(additive);
  const missingOriginalPin=structuredClone(initiallyPinned.checklist);delete missingOriginalPin.items[0].verificationIntent.happy[0].verification;store.writeChecklist(storyId,missingOriginalPin);
  assert.notEqual(readStoryScopeBudget(store,root,storyId).status,'approved_large_story','an originally approved pin cannot be removed');negativeLabels.push('original approved pin removal');
  const replacedOriginalPin=structuredClone(initiallyPinned.checklist);replacedOriginalPin.items[0].verificationIntent.happy[0].verification.command='node --version';store.writeChecklist(storyId,replacedOriginalPin);
  assert.notEqual(readStoryScopeBudget(store,root,storyId).status,'approved_large_story','an originally approved pin cannot be replaced');negativeLabels.push('original approved pin replacement');
  store.writeChecklist(storyId,initiallyPinned.checklist);setConfig(config);
  git('switch','-q',`story/${storyId}`);
  const removed=structuredClone(pinned);removed.items=removed.items.filter(i=>i.id!=='CHK-006');store.writeChecklist(storyId,removed);
  git('add','.');git('commit','-qm','synthetic removed pinned item');
  store.writeChecklist(storyId,pinned);git('add','.');git('commit','-qm','synthetic restored pinned item');
  refused('removed then restored pinned item cannot erase transition');
  console.log('SCOPE_APPROVAL_CONTINUITY_NEGATIVES '+JSON.stringify(negativeLabels));
  console.log('SCOPE_APPROVAL_CONTINUITY_PASS');
} finally {process.chdir(priorCwd);rmSync(root,{recursive:true,force:true});}
