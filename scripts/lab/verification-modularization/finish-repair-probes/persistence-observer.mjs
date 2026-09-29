import {resolve} from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const target=pathToFileURL(resolve('packages/main/dist/tasks/validate-execution-lock-smoke.js')).href;
const mutate=process.argv.includes('--stale-marker');
if(process.argv.length===2)process.argv.push('--selected-observer');
const hook=registerHooks({load(url,context,next){const result=next(url,context);if(url!==target)return result;
 let source=String(result.source);const at=source.indexOf('void (async () => {');assert(at>0);source=source.slice(0,at);
 if(mutate){const guard='if(this.projectRoot===root&&id===storyId){';assert(source.includes(guard));source=source.replace(guard,"if(this.projectRoot===root&&id===storyId&&process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL!=='persistence-observer'){");const spawn="const proc = spawnValidate(root, storyId, 'persistence-observer');";assert(source.includes(spawn));source=source.replace(spawn,"writeFileSync(observed,JSON.stringify({pid:-1,label:'setup'}));\n    "+spawn);}
 source+="\ntry {await assertPostCommandPersistenceHoldsLock(); console.log('LOCK_OBSERVER_SELECTED_CASE_ACCEPTED');} finally {cleanupNativeLockRoots();}\n";
 return {...result,source};}});
try{await import(target);}finally{hook.deregister();}
