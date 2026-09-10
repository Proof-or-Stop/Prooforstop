import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const ts=createRequire(pathToFileURL(process.env.U17_REPO+'/package.json'))('typescript');
const target='emits exactly rounds x 2 verdicts after current reviewer passes';
const attemptModule=new URL('./u17-attempt-capture.mjs',import.meta.url).href;
const hook=fileURLToPath(new URL('./u17-original-abba-hook.mjs',import.meta.url));
registerHooks({load(url,context,next){if(!url.endsWith('/tasks/quorum-submit-smoke.js'))return next(url,context);let source=readFileSync(new URL(url),'utf8');const anchor='function check(name, fn) {';if(source.split(anchor).length!==2)throw new Error('quorum check anchor changed');const ast=ts.createSourceFile('quorum.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const calls=[];function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='check'&&n.arguments.length>0&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text===target)calls.push(n);ts.forEachChild(n,visit);}visit(ast);if(calls.length!==1)throw new Error('original target call changed');const start=calls[0].getStart(ast),end=calls[0].getEnd()-1;source=source.slice(0,start)+'await '+source.slice(start,end)+', () => result'+source.slice(end);source=source.replace(/^#![^\n]*\n/,'');source="import {validateAttemptReceipts,drainAttemptClosures} from "+JSON.stringify(attemptModule)+";\nimport * as u17fs from 'node:fs';\n"+source.replace(anchor,`let u17Finished=false;
function check(name, fn, u17ReadResult) {
 if(u17Finished)return;
 if(name!==${JSON.stringify(target)}){fn();passed++;console.log('U17_PREFIX_PASS '+name);return;}
 return (async()=>{
 const out=process.env.U17_AB_OUTPUT_DIR;if(!out)throw new Error('U17 output directory required');
 const backup=u17fs.mkdtempSync(out+'/baseline-');u17fs.cpSync(root,backup+'/tree',{recursive:true});
 const baselineHead=git(root,['rev-parse','HEAD']);const originalEnv={NODE_OPTIONS:process.env.NODE_OPTIONS,U17_MEMO_MODE:process.env.U17_MEMO_MODE,U17_AB_CHILD_METRICS:process.env.U17_AB_CHILD_METRICS};const rounds=[];
 try {for(const[index,mode]of ['on','off','off','on'].entries()){
  if(index){process.chdir(out);u17fs.rmSync(root,{recursive:true,force:true});u17fs.cpSync(backup+'/tree',root,{recursive:true});process.chdir(root);}
  assert.equal(git(root,['rev-parse','HEAD']),baselineHead);
  const memo=globalThis.__u17MemoAB;if(!memo)throw new Error('memo hook missing');assert.deepEqual([...memo.resetters.keys()].sort(),['current:evidence-freshness','current:git-probe','current:story-aware-validation','current:story-git-bytes','historical:evidence-freshness','historical:story-aware-validation'].sort());assert.equal(memo.baselineModules.length,2);memo.mode=mode;resetConfigCache();memo.reset();
  process.env.U17_MEMO_MODE=mode;process.env.U17_AB_CHILD_METRICS=out+'/child-'+index;process.env.NODE_OPTIONS=(originalEnv.NODE_OPTIONS??'')+' --import='+JSON.stringify(${JSON.stringify(hook)});
  console.log('U17_TARGET_ROUND_START '+JSON.stringify({index,mode}));const attemptStart=memo.attempts.length;const before=memo.snapshot(),started=performance.now();fn();const durationMs=performance.now()-started,after=memo.snapshot();
  const counts=Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]]));
  const drainStarted=performance.now();let drainError;try{await drainAttemptClosures(memo.attempts.slice(attemptStart));}catch(error){drainError=error;}const drainageMs=performance.now()-drainStarted;
  const childMetrics=u17fs.readdirSync(out).filter(file=>file.startsWith('child-'+index+'.')&&file.endsWith('.json')).map(file=>JSON.parse(u17fs.readFileSync(out+'/'+file,'utf8')));const attempts=memo.attempts.slice(attemptStart);u17fs.writeFileSync(out+'/attempts-'+index+'.json',JSON.stringify({index,mode,counts,attempts,childMetrics,drainageMs,drainError:drainError?.message},null,2));if(drainError)throw drainError;const attemptSummary=validateAttemptReceipts(attempts,childMetrics);for(const child of childMetrics){assert.equal(child.mode,mode);assert.equal(child.baselineModules.length,2);}
  const row={index,mode,baselineHead,durationMs,drainageMs,counts,attemptSummary,childMetrics,assertions:'original-target-body-passed',baselineModules:memo.baselineModules,emittedCount:u17ReadResult().emittedCount,runIds:u17ReadResult().runIds,hostVerdicts:hostVerdictEventCount(store),verdictFiles:verdictFileCount(root)};rounds.push(row);u17fs.writeFileSync(out+'/round-'+index+'.json',JSON.stringify(row,null,2));console.log('U17_TARGET_ROUND '+JSON.stringify(row));
 }
 assert.equal(rounds.length,4);for(const row of rounds){assert.equal(row.emittedCount,6);assert.equal(row.hostVerdicts,6);assert.equal(row.verdictFiles,6);assert.deepEqual(row.runIds,rounds[0].runIds);}
 u17fs.writeFileSync(out+'/target-results.json',JSON.stringify({target:name,rounds,dynamicFieldsExcluded:['timestamps','signatures','resultingCommitSha'],scope:'original-target-with-all-prefix-checks',comparison:'story-hash historical3f010 versus current; material/root exact-hit bypass in off; not an entire historical checkout'},null,2));u17Finished=true;passed++;console.log('U17_ORIGINAL_TARGET_ABBA_PASS');
 }finally{for(const[k,v]of Object.entries(originalEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}u17fs.rmSync(backup,{recursive:true,force:true});}
 })();
`);return{format:'module',source,shortCircuit:true};}});
