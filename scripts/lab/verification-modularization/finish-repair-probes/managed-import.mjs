import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const mutate=process.argv.includes('--duplicate-creator');
const directory=pathToFileURL(resolve('packages/main/dist/tasks/managed-review-evidence')+'/').href;
const entry=resolve('packages/main/dist/tasks/managed-review-evidence-smoke.js');
process.argv=[process.execPath,entry,'--capability=codex-transport'];
registerHooks({load(url,context,next){const result=next(url,context);if(!url.startsWith(directory))return result;
const name=url.slice(directory.length);if(!['codex-transport.js','claude-transport.js','evidence-binding.js'].includes(name))return result;
let source=String(result.source);
if(mutate&&name==='codex-transport.js'){
const needle="const concurrentImportResults = importWorkers.map(worker => readFileSync(worker.resultPath, 'utf8'));";
assert(source.includes(needle));source=source.replace(needle,needle+"\nconcurrentImportResults.fill('Managed review evidence imported');");}
return {...result,source};}});
await import(pathToFileURL(entry).href);
