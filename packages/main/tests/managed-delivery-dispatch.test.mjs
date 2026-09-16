/** Synthetic transport regression; never an independent Story review credential. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { readManagedHostRunProjection } from '../dist/core/managed-host-run.js';
const root=mkdtempSync(join(tmpdir(),'managed-delivery-regression-'));
const storyId='B-managed-delivery';
try {
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',outDir:'dist',testsDir:'tests',fixturesDir:'tests/fixtures',storyDir:'.proof-or-stop/story/actives',requirementsDir:'docs/requirements'}));
  mkdirSync(join(root,'src'));writeFileSync(join(root,'src/subject.ts'),'export const value=true;\n');
  const git=(...a)=>execFileSync('git',a,{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');git('config','user.name','Delivery fixture');git('config','user.email','delivery@example.invalid');
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'managed-delivery',title:'Managed delivery review',description:'Bounded delivery transport regression.',type:'bug',phase:'TEST',priority:'medium',createdAt:new Date().toISOString(),events:[]});
  store.writeChecklist(storyId,{items:[]});git('add','.');git('commit','-qm','fixture');
  const handler=createHostRunHandlers({root,scanRoot:root,store},{runner:async()=>({stdout:'{"type":"turn.completed","usage":{}}\n',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed',replacementSafe:true})});
  let result;
  try { result=await handler.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:30000,timeoutMs:20000,json:true}); }
  catch(error){assert.fail('MANAGED_DELIVERY_ROLE_UNSUPPORTED: '+error.message);}
  assert.equal(result.exitCode,1,'A provider exit alone must not certify delivery');
  assert.equal(readManagedHostRunProjection(root,result.runId).terminal?.reason,'managed_dispatch_output_missing');
  assert.equal(store.readDeliveryCheck(storyId),null);
  console.log('MANAGED_DELIVERY_DISPATCH_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
