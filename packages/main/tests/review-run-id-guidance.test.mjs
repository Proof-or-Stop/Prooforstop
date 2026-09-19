import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
assert.equal(spawnSync(process.execPath,['scripts/ensure-dist.mjs'],{cwd:repository,stdio:'inherit'}).status,0);
const {StoryStore}=await import('../dist/core/store.js');
const {resetConfigCache}=await import('../dist/core/config.js');
const {createSessionHandlers}=await import('../dist/handlers/session.js');
const root=mkdtempSync(join(tmpdir(),'review-run-id-guidance-'));
try {
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({
    scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',
    workflow:{profile:'balanced'},
  }));
  resetConfigCache();
  const store=new StoryStore(root),storyId='B-run-id',now=new Date().toISOString();
  for(const args of [['init'],['config','user.email','review-guidance@example.invalid'],
    ['config','user.name','Review Guidance Fixture'],['add','proof-or-stop.config.json'],
    ['commit','-m','isolated fixture'],['checkout','-b',`story/${storyId}`]]) {
    const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
  store.writeStory(storyId,{
    storyId,name:'review-run-id-guidance',title:'Review run binding guidance',
    description:'Isolated pending REVIEW fixture for actual session guidance.',
    type:'chore',phase:'REVIEW',priority:'medium',createdAt:now,startedAt:now,
    endedAt:null,currentReviewRound:now,events:[{phase:'REVIEW',action:'advance',timestamp:now}],
  });
  store.writeChecklist(storyId,{items:[]});
  const brief=createSessionHandlers({store,root,scanRoot:join(root,'packages/main')}).session_brief({concise:true});
  assert.match(brief,/Anti-stall \(REVIEW\)/,'fixture must reach the real pending REVIEW hint');
  assert.match(brief,/reviewer_batch/);
  assert.match(brief,/canonical dispatch prompt unchanged/);
  assert.match(brief,/retain every nonempty returned child id/);
  assert.match(brief,/require distinct ids for parallel lanes/);
  assert.match(brief,/wait only on those exact ids/);
  assert.match(brief,/reviewer then records its own review_run_start/);
  assert.match(brief,/finding_add or review_pass_set/);
  assert.match(brief,/<reviewRunId from proof-or-stop review_run_start>/,
    'REVIEW_RUN_ID_GUIDANCE_RED: reviewer evidence must use its returned signed run id');
  assert.doesNotMatch(brief,/:RR-001/,'do not suggest a fabricated run id');
  console.log('REVIEW_RUN_ID_GUIDANCE_GREEN canonical child dispatch and returned run binding preserved');
} finally {
  rmSync(root,{recursive:true,force:true});
  resetConfigCache();
}
