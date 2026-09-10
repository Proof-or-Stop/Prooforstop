#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {persistSyntheticAdmittedWindowForTest,persistRunningCertificationWindow,signCertificationWindow,signPrecertReceipt} from '../packages/main/dist/core/certification-window.js';
import {deriveCertificationDomainInputHashes} from '../packages/main/dist/handlers/certification-window.js';
import {validationCloseoutAdvancePaths} from '../packages/main/dist/handlers/done-prepare.js';
const root=mkdtempSync(join(tmpdir(),'pos-closeout-order-')),storyId='B-order-proof';
const git=a=>execFileSync('git',a,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
const commit=()=>{git(['add','.']);git(['commit','-qm','Lab fixture change']);return git(['rev-parse','HEAD']);};
try{
 git(['init','-q']);git(['config','user.name','Lab']);git(['config','user.email','lab@example.invalid']);
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/locks/\n.proof-or-stop/runtime/\n');
 commit();const store=new StoryStore(root);
 store.writeStory(storyId,{storyId,phase:'TEST',name:'lab',title:'Lab',createdAt:new Date().toISOString()});
 store.writeChecklist(storyId,{items:[]});commit();
 persistSyntheticAdmittedWindowForTest({store,storyId,projectRoot:root,causalInputHashes:deriveCertificationDomainInputHashes(root,'HEAD',root)});
 const before=commit();const admitted=store.readCertificationWindows(storyId);
 persistRunningCertificationWindow({store,storyId});const after=commit();
 const ctx={root,scanRoot:root,store};
 const verdict=validationCloseoutAdvancePaths(ctx,storyId,root,before,after);
 console.log(JSON.stringify({before,after,verdict}));
 assert.equal(verdict.eligible,true,'CERTIFICATION_RUNNING_ADVANCE_MUST_NOT_INVALIDATE_CLOSEOUT: '+verdict.reasons.join(';'));
 // Admission, frozen input changes and corrupted signatures must never become
 // trusted merely because they use this filename. All mutations are disposable.
 const good=store.readCertificationWindows(storyId);
 for(const kind of ['frozen','state','hash','receipts','window','backwards','malformed']){
  const data=structuredClone(good);const last=data.windows.at(-1);
  if(kind==='frozen')last.frozen.materialHash='changed';
  if(kind==='state')last.state='ADMITTED';
  if(kind==='receipts')data.receipts.push(structuredClone(data.receipts[0]));
  if(kind==='window')data.windows.push(structuredClone(last));
  if(kind==='backwards')last.updatedAt='2000-01-01T00:00:00.000Z';
  if(kind==='hash')last._hash='tampered';
  else {const {_hash,...unsigned}=last;last._hash=signCertificationWindow(unsigned);}
  store.writeCertificationWindows(storyId,data);
  if(kind==='malformed')writeFileSync(store.storyFilePath(storyId,'certification-window.json'),'{broken');
  const bad=commit();
  assert.equal(validationCloseoutAdvancePaths(ctx,storyId,root,before,bad).eligible,false,kind+' must fail closed');
 }
 const unauthorized=structuredClone(admitted);
 const wrongReceipt=unauthorized.receipts[0];wrongReceipt.windowId='different-window';
 const {_hash:oldReceiptHash,...receiptFields}=wrongReceipt;wrongReceipt._hash=signPrecertReceipt(receiptFields);
 store.writeCertificationWindows(storyId,unauthorized);const unauthorizedBefore=commit();
 const attempted=structuredClone(unauthorized);const next=attempted.windows.at(-1);next.state='RUNNING';next.updatedAt=new Date().toISOString();
 const {_hash:oldWindowHash,...windowFields}=next;next._hash=signCertificationWindow(windowFields);
 store.writeCertificationWindows(storyId,attempted);const unauthorizedAfter=commit();
 assert.equal(validationCloseoutAdvancePaths(ctx,storyId,root,unauthorizedBefore,unauthorizedAfter).eligible,false,'valid digests cannot substitute for prior heavy-certification authority');
 rmSync(store.storyFilePath(storyId,'certification-window.json'));const absentBefore=commit();
 store.writeCertificationWindows(storyId,good);const presentAfter=commit();
 assert.equal(validationCloseoutAdvancePaths(ctx,storyId,root,absentBefore,presentAfter).eligible,false,'new admission is not a running-only advance');
 console.log('CERTIFICATION_ORDER_GREEN: one positive and nine negative controls');
}finally{rmSync(root,{recursive:true,force:true});}
