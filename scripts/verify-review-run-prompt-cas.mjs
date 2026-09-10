import {tmpdir} from 'node:os';
import {readFileSync,existsSync,mkdtempSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../', import.meta.url));
const prefix=pathToFileURL(join(root,'packages/main/dist/')).href;
const {signReviewRun,verifyReviewRun}=await import(prefix+'core/review-run.js');
const {CURRENT_PROMPT_IDENTITIES:I,domainSeparatedDigest}=await import(prefix+'core/prompt-contracts.js');
const {writePromptBody}=await import(prefix+'core/prompt-body-store.js');
const {StoryStore}=await import(prefix+'core/store.js');
const dir=mkdtempSync(join(tmpdir(),'review-cas-boundary-'));const store=new StoryStore(dir);const storyDir=store.storyDirPath('B-cas');
let count=0;function check(x,message){assert.ok(x,message);count++}
function issue(body){const promptHash=domainSeparatedDigest('assembled-prompt.raw-utf8.v1',body);const r={storyId:'B-cas',reviewRunId:'B-cas:RR-001',agent:'proof-or-stop-review-behavior',lane:'proof-or-stop-review-behavior',reviewRound:'round',startedAt:'now',headHash:'head',materialHash:'material',promptHash,envelopeId:'e'.repeat(64),assembledPromptRef:writePromptBody(storyDir,body,promptHash)};r._hash=signReviewRun(r.storyId,r.reviewRunId,r.agent,r.lane,r.reviewRound,r.startedAt,r.headHash,r.materialHash,r.promptHash,undefined,undefined,undefined,r.envelopeId);return r}
try{const body=[I.roleContract,I.fullTaskContext,I.knownExecutionEnvironment].map(schemaVersion=>JSON.stringify({schemaVersion})).join('\n');const r=issue(body);
check(verifyReviewRun(r,store),'canonical CAS signed metadata + real body accepted');
check(!verifyReviewRun(r),'reference without trusted path is refused');
check(!verifyReviewRun({...r,assembledPromptRef:'a'.repeat(64)},store),'substituted reference refused');
check(!verifyReviewRun({...r,assembledPrompt:body},store),'inline plus reference refused');
check(!verifyReviewRun({...r,extra:true},store),'unknown field refused');
check(!verifyReviewRun({...r,_hash:'bad'},store),'signature invalid refused');
const old=issue(body.replace(I.roleContract,'lattice.role_contract.v1'));check(!verifyReviewRun(old,store),'correct own signature and digest cannot bless obsolete family');
const path=join(storyDir,'prompt-bodies',r.promptHash+'.txt');writeFileSync(path,body+'bad');check(!verifyReviewRun(r,store),'tampered physical body refused');unlinkSync(path);check(!verifyReviewRun(r,store),'missing physical body refused');writeFileSync(path,body);check(verifyReviewRun(r,store),'restored exact bytes accepted');
console.log(`PASS ${count} actual signed CAS boundary checks`);
}finally{rmSync(dir,{recursive:true,force:true})}
