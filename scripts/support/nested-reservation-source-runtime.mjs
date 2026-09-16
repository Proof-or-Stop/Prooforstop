import {mkdtempSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
// Test-only OS-home lookup isolation. It creates no alternate production pool,
// ticket, signature or caller-authored authority; real queue APIs create them.
export function nestedSourceRuntime(repo, patchSource='function patch(_url,source){return source;}') {
 const base=mkdtempSync(join(tmpdir(),'nested-reservation-fault-'));
 const loader=join(base,'loader.mjs');
 const delegation=pathToFileURL(join(repo,'packages/main/src/core/validation-reservation-delegation.ts')).href;
 const lock=pathToFileURL(join(repo,'packages/main/src/core/validation-execution-lock.ts')).href;
 const executor=pathToFileURL(join(repo,'packages/main/src/core/validation-executor.ts')).href;
 const observeAnchor="socket.once('connect', () => socket.write(JSON.stringify({ ...input, pid: self.pid, start: self.start, nonce }) + '\\n'));";
 const observeReplacement="socket.once('connect', () => {socket.write(JSON.stringify({ ...input, pid: self.pid, start: self.start, nonce }) + '\\n');if(input.operation==='grant')process.send?.({requestSent:true});});";
  // The TypeScript compiler is resolved from packages/main through Node's own algorithm, hoisted or not.
 const typescriptPath=createRequire(join(repo,'packages/main/package.json')).resolve('typescript');
const writeLoader=source=>writeFileSync(loader,`import os from 'node:os';import {syncBuiltinESMExports,registerHooks} from 'node:module';import {readFileSync,existsSync} from 'node:fs';import ts from ${JSON.stringify(typescriptPath)};import ${JSON.stringify(join(repo,'scripts/lab-source-loader.mjs'))};const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(join(base,'home'))}});syncBuiltinESMExports();${source}function observe(url,source){if(url!==${JSON.stringify(delegation)}||!process.argv.includes('--request-observer'))return source;const anchor=${JSON.stringify(observeAnchor)};if(source.split(anchor).length!==2)throw Error('request observer anchor mismatch');return source.replace(anchor,${JSON.stringify(observeReplacement)});}registerHooks({load(url,context,next){if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(observe(url,patch(url,readFileSync(new URL(url),'utf8'))),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,context);}});`);
 writeLoader(patchSource);
 return {base,loader,delegation,lock,executor,writeLoader,env:{...process.env,NODE_OPTIONS:'--import='+JSON.stringify(loader)}};
}
