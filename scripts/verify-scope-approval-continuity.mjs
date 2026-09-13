/** Disposable signed fixtures are synthetic authorization, never operator acknowledgements. */
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
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
  const config={scanRoot:'.',rootDir:'.',storyDir:'.proof-or-stop/story/actives',validate:{commands:['node verify.cjs']},
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
  const approvalPath=store.storyFilePath(storyId,'scope-budget-decisions.json'),approvalBytes=readFileSync(approvalPath);
  const report=()=>{const r=readStoryScopeBudget(store,root,storyId);assert.deepEqual(readFileSync(approvalPath),approvalBytes,'budget reads cannot rewrite authorization');return r;};
  assert.equal(report().status,'approved_large_story','exact signed binding remains accepted');
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
  console.log('SCOPE_APPROVAL_CONTINUITY_PASS');
} finally {process.chdir(priorCwd);rmSync(root,{recursive:true,force:true});}
