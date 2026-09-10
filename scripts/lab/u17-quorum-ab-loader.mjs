import {fileURLToPath} from 'node:url';import {mkdirSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const preload=fileURLToPath(new URL('./u17-memo-ab-preload.mjs',import.meta.url));
const outputParent=process.env.U17_AB_OUTPUT_DIR??tmpdir();mkdirSync(outputParent,{recursive:true});const outputDir=mkdtempSync(join(outputParent,'u17-quorum-results-'));console.log('U17_AB_OUTPUT_DIR '+outputDir);
import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';
registerHooks({load(url,context,next){if(!url.endsWith('/tasks/quorum-submit-smoke.js'))return next(url,context);let text=readFileSync(new URL(url),'utf8');const label="check('worktree-local CLI commits the exact quorum batch through the production entrypoint', () => {";const start=text.indexOf(label),end=text.indexOf("    check('",start+label.length);if(start<0||end<0)throw new Error('quorum case anchors changed');let block=text.slice(start,end);const begin='recordReviewerPasses(fixture.registry);';const last='assert.equal(verdictFileCount(fixture.root), 6);';if(block.split(begin).length!==2||block.split(last).length!==2)throw new Error('quorum assertions anchors changed');block=block.replace(begin,begin+`
const abBackup=__abfs.mkdtempSync(${JSON.stringify(join(outputDir,'baseline-'))});
__abfs.cpSync(fixture.root,abBackup+'/tree',{recursive:true});
const abHead=git(fixture.root,['rev-parse','HEAD']);
const abEnv={NODE_OPTIONS:process.env.NODE_OPTIONS,U17_MEMO_MODE:process.env.U17_MEMO_MODE,U17_METRICS_PREFIX:process.env.U17_METRICS_PREFIX};
try { for(const [abIndex,abMode] of ['on','off','off','on'].entries()){
if(abIndex){__abfs.rmSync(fixture.root,{recursive:true,force:true});__abfs.cpSync(abBackup+'/tree',fixture.root,{recursive:true});process.chdir(fixture.root);resetConfigCache();}
assert.equal(git(fixture.root,['rev-parse','HEAD']),abHead);
process.env.NODE_OPTIONS=(abEnv.NODE_OPTIONS??'')+' --import='+JSON.stringify(${JSON.stringify(preload)});process.env.U17_MEMO_MODE=abMode;process.env.U17_METRICS_PREFIX=${JSON.stringify(join(outputDir,'quorum-ab-'))}+abIndex;
const abStarted=performance.now();
`).replace(last,last+`
console.log('U17_QUORUM_AB '+JSON.stringify({mode:abMode,index:abIndex,baselineHead:abHead,durationMs:performance.now()-abStarted,hostVerdicts:hostVerdictEventCount(fixture.store),verdictFiles:verdictFileCount(fixture.root)}));
}} finally {for(const[k,v]of Object.entries(abEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__abfs.rmSync(abBackup,{recursive:true,force:true});}
`);text=text.slice(0,start)+block+text.slice(end);return{format:'module',source:"import * as __abfs from 'node:fs';\n"+text.replace(/^#![^\n]*\n/,''),shortCircuit:true};}});
