import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StoryStore} from '../../packages/main/dist/core/store.js';
import {createChecklistHandlers} from '../../packages/main/dist/handlers/checklist.js';
import {acquireOwnerLease,releaseOwnerLease} from '../../packages/main/dist/core/story-owner-lease.js';
import {digestCanonicalJson} from '../../packages/main/dist/core/digest.js';
import {buildVerificationCoverage} from '../../packages/main/dist/core/verification.js';
import {resetConfigCache} from '../../packages/main/dist/core/config.js';
const root=mkdtempSync(join(tmpdir(),'pos-acceptance-channel-'));const storyId='B-acceptance-lab';
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
try {
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src/subject.js'),'export const subject=true;\n');
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
 git(['init','-q','-b','work']);git(['config','user.name','Lab test']);git(['config','user.email','lab@example.test']);git(['add','.']);git(['commit','-qm','fixture']);git(['branch','main']);resetConfigCache();
 const store=new StoryStore(root);store.writeStory(storyId,{storyId,title:'Acceptance correction',name:'acceptance-correction',phase:'DEV',type:'chore',priority:'medium',createdAt:new Date().toISOString()});
 const original={id:'CHK-001',title:'Preserve original scope',context:'Prove boundary behavior',status:'done',startTime:null,endTime:null,files:{modify:['src/subject.js'],create:[],test:[]},verificationIntent:{happy:[{id:'OLD',desc:'Original requirement',type:'cli',priority:'must'}],edge:[],adversarial:[]},verificationEvidence:[]};
 store.writeChecklist(storyId,{items:[original]});
 acquireOwnerLease(store.storyDirPath(storyId),{command:'fixture',cwd:root});
 const h=createChecklistHandlers({store,root,scanRoot:root});
 assert.equal(typeof h.verification_intent_append,'function','ACCEPTANCE_CHANNEL_MISSING');
 const request={storyId,itemId:'CHK-001',expectedIntentHash:digestCanonicalJson(original.verificationIntent),reason:'The discovered boundary case strengthens coverage within the existing item scope.',addition:{edge:[{id:'NEW',desc:'The identified boundary must pass',type:'cli',priority:'must'}]}};
 const before=readFileSync(store.storyDirPath(storyId)+'/checklist.json','utf8');
 for(const change of [{expectedIntentHash:'0'.repeat(64)},{reason:'short'},{addition:{happy:[{id:'OLD',desc:'replace original',type:'cli',priority:'must'}]}},{addition:{edge:[{id:'NEW',desc:'optional escape',type:'cli',priority:'should'}]}},{addition:{edge:[{id:'NEW',desc:'fake receipt',type:'cli',priority:'must',verification:{command:'true',selector:'PASS'}}]}}]) {
  assert.throws(()=>h.verification_intent_append({...request,...change}));assert.equal(readFileSync(store.storyDirPath(storyId)+'/checklist.json','utf8'),before);
 }
 releaseOwnerLease(store.storyDirPath(storyId));assert.throws(()=>h.verification_intent_append(request),/OWNER/);acquireOwnerLease(store.storyDirPath(storyId),{command:'fixture',cwd:root});
 const result=h.verification_intent_append(request);const item=store.readChecklist(storyId).items[0];
 assert.deepEqual(item.verificationIntent.happy,original.verificationIntent.happy);assert.deepEqual(item.files,original.files);assert.deepEqual(item.verificationEvidence,[]);
 assert.equal(item.status,'in_progress');assert.equal(item.verificationIntent.edge[0].id,'NEW');assert.ok(item.verificationIntentAmendments[0].signature.startsWith('ed25519:'));
 assert.equal(buildVerificationCoverage({items:[item]}).missingRequired,2);assert.throws(()=>h.verification_intent_append(request),/STALE/);
 // Mutation fixtures use the test Store API; no real Story files are touched.
 const tampered=structuredClone(item);tampered.verificationIntent.edge[0].desc='Changed without authorization';
 assert.throws(()=>store.writeChecklist(storyId,{items:[tampered]}),/AMENDMENT/);
 const terminal=store.readStory(storyId);terminal.phase='TEST';store.writeStory(storyId,terminal);assert.throws(()=>h.verification_intent_append({...request,expectedIntentHash:digestCanonicalJson(item.verificationIntent)}),/DEV/);
 console.log('ACCEPTANCE_CHANNEL_GREEN '+result);
}finally{rmSync(root,{recursive:true,force:true});resetConfigCache();}
