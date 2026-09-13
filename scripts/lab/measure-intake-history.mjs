import cp from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const baseline = '082ea1d962';
const paths = ['git-baseline','story-workspace','story-signed-workspace-resolution','worktree-runtime'];
const git = (cwd,args) => cp.execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
if (process.argv[2] === '--child') {
  const [mode,root] = process.argv.slice(3); const modules=[];
  if (mode === 'before') registerHooks({load(url,context,next) {
    const name=paths.find(name=>url===new URL(`../../packages/main/dist/core/${name}.js`,import.meta.url).href);
    if (!name) return next(url,context);
    const path=`packages/main/src/core/${name}.ts`; const source=git(repo,['show',`${baseline}:${path}`]);
    modules.push({path,sha256:createHash('sha256').update(source).digest('hex')});
    return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
  }});
  const {resolveStoryWorkspace}=await import('../../packages/main/dist/core/story-workspace.js');
  const {currentStoryFilesHash}=await import('../../packages/main/dist/core/evidence-freshness.js');
  const {resolveRepositoryBaseline}=await import('../../packages/main/dist/core/git-baseline.js');
  const story={storyId:'B-intake',phase:'INIT',name:'In-memory benchmark'};
  const ctx={root,store:{readStory:()=>story,storyDirPath:()=>join(root,'unused-metadata')}};
  const original=cp.execFileSync;
  function measure(fn) { const commands=[];const values=[];
    cp.execFileSync=function(cmd,args,options){if(cmd==='git')commands.push(args);return original.call(this,cmd,args,options);};syncBuiltinESMExports();
    const start=performance.now();try {for(let i=0;i<20;i++)values.push(fn());}finally{cp.execFileSync=original;syncBuiltinESMExports();}
    return {ms:performance.now()-start,gitCalls:commands.length,worktreeCalls:commands.filter(a=>a[0]==='worktree').length,treeCalls:commands.filter(a=>a[0]==='ls-tree').length,diffCalls:commands.filter(a=>a[0]==='diff').length,values};
  }
  const workspace=measure(()=>{const r=resolveStoryWorkspace(ctx,story.storyId,{config:{}});return {gitCwd:r.gitCwd,worktreePath:r.worktreePath,source:r.source,rootReason:r.rootReason};});
  const hash=measure(()=>currentStoryFilesHash(root));
  const baselineResult=measure(()=>resolveRepositoryBaseline(root));
  console.log(JSON.stringify({mode,modules,workspace,hash,baseline:baselineResult}));
} else {
  const {verifyBuildBinding}=await import('../full-suite-build-binding.mjs');
  const binding=verifyBuildBinding(repo);
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'intake-history-abba-')));
  try {git(root,['init','-q','-b','main']);git(root,['config','user.name','Lab']);git(root,['config','user.email','lab@example.invalid']);
    fs.mkdirSync(join(root,'src'));for(let i=0;i<50;i++)fs.writeFileSync(join(root,'src',`file-${i}.ts`),`export const value${i} = ${i};\n`);
    git(root,['add','.']);git(root,['commit','-qm','fixture']);const fixtureHead=git(root,['rev-parse','HEAD']);
    const rows=[];for(const mode of ['before','after','after','before'])rows.push(JSON.parse(cp.execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--child',mode,root],{cwd:repo,encoding:'utf8',timeout:120000})));
    for(const row of rows)for(const key of ['workspace','hash','baseline'])assert.deepEqual(row[key].values,rows[0][key].values);
    assert.equal(git(root,['rev-parse','HEAD']),fixtureHead);assert.deepEqual(verifyBuildBinding(repo),binding);
    const result={baseline:git(repo,['rev-parse',baseline]),candidate:git(repo,['rev-parse','HEAD']),binding,fixtureHead,rows};
    const output=resolve(process.argv[2]||'/tmp/intake-history-abba.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
    console.log('INTAKE_ABBA_GREEN '+output);for(const r of rows)console.log(JSON.stringify({mode:r.mode,...Object.fromEntries(['workspace','hash','baseline'].map(k=>[k,{ms:r[k].ms,gitCalls:r[k].gitCalls,worktreeCalls:r[k].worktreeCalls}]))}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
