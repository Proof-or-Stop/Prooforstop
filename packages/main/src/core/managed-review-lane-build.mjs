import {pathToFileURL} from 'node:url';
/** Trusted isolated runtime builder. Called by an awaited child; never root build. */
import {symlinkSync,readlinkSync,cpSync,mkdirSync,readdirSync,lstatSync,readFileSync,writeFileSync,chmodSync,renameSync,existsSync,realpathSync} from 'node:fs';
import {join,relative,dirname,resolve,isAbsolute} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const packages=['main','utils','graph','lab'];
export function buildManagedReviewLane({source,buildSource,outputs,temporary,cache,headHash,toolRoot,originalWorktree=toolRoot,buildTimeoutMs=180000}) {
 for(const p of [source,buildSource,outputs,temporary,cache,toolRoot]) if(realpathSync(p)!==p)throw Error('noncanonical lane build path');
 if(readdirSync(buildSource).length||readdirSync(outputs).length)throw Error('lane build directories must be fresh');
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim()!==headHash)throw Error('lane HEAD drift');
 const files=execFileSync('git',['ls-files','-z'],{cwd:source,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
 const outputRelative=relative(source,outputs);if(outputRelative!=='.proof-or-stop/runtime/managed-review-build'||files.some(file=>file===outputRelative||file.startsWith(outputRelative+'/')||outputRelative.startsWith(file+'/')))throw Error('lane output is not a fresh registered untracked subtree');
 const digest=()=>{const h=createHash('sha256');for(const f of files){const p=join(source,f);h.update(f+'\0');if(lstatSync(p).isSymbolicLink()){const target=readlinkSync(p),rel=relative(source,resolve(dirname(p),target));if(isAbsolute(target)||rel==='..'||rel.startsWith('../'))throw Error('tracked symlink escapes source');h.update('symlink\0'+target);}else{h.update('file\0');h.update(readFileSync(p));}}return h.digest('hex');};
 const before=digest();for(const f of files){const src=join(source,f),dst=join(buildSource,f);mkdirSync(dirname(dst),{recursive:true});if(lstatSync(src).isSymbolicLink())symlinkSync(readlinkSync(src),dst);else cpSync(src,dst);}
 if(digest()!==before)throw Error('source changed while copying lane');
 const require=createRequire(join(toolRoot,'package.json')),tsc=require.resolve('typescript/bin/tsc');
 const compilerRoot=dirname(dirname(realpathSync(tsc))),compilerPackage=JSON.parse(readFileSync(join(compilerRoot,'package.json'),'utf8'));
 if(compilerPackage.name!=='typescript'||typeof compilerPackage.bin?.tsc!=='string'||realpathSync(join(compilerRoot,compilerPackage.bin.tsc))!==realpathSync(tsc))throw Error('compiler package bin identity mismatch');
 const compilerFiles=[];function sealCompiler(path){const st=lstatSync(path);if(st.isSymbolicLink())throw Error('compiler tree contains unsupported symlink');if(st.isDirectory()){for(const name of readdirSync(path).sort())sealCompiler(join(path,name));}else if(st.isFile())compilerFiles.push({path,digest:createHash('sha256').update(readFileSync(path)).digest('hex')});else throw Error('compiler tree non-file');}sealCompiler(compilerRoot);
 const dependencySearch=require.resolve.paths('typescript')??[];
 const protectedDist=packages.flatMap(name=>[join(toolRoot,'packages',name,'dist'),join(originalWorktree,'packages',name,'dist'),...dependencySearch.filter(existsSync).map(path=>join(dirname(realpathSync(path)),'packages',name,'dist'))]);
 const policy=['(version 1)','(allow default)','(deny file-write*)','(allow file-write* (literal "/dev/null"))',...[outputs,temporary,cache].map(p=>`(allow file-write* (subpath ${JSON.stringify(p)}))`),...protectedDist.map(p=>`(deny file-read* (subpath ${JSON.stringify(p)}))`)].join('\n');
 // Build private package containers. Third-party dependencies remain readonly;
 // every workspace package resolves to this runtime, never an original dist.
 function mapDependencies(installed,dest){mkdirSync(dest,{recursive:true});if(existsSync(installed))for(const name of readdirSync(installed)){if(name.startsWith('.'))continue;const src=join(installed,name);if(name.startsWith('@')){mapDependencies(src,join(dest,name));continue;}const dst=join(dest,name);if(existsSync(dst))continue;let target=realpathSync(src);try{const pkg=JSON.parse(readFileSync(join(target,'package.json'),'utf8'));const owned=packages.find(n=>pkg.name===`@proof-or-stop/${n==='main'?'core':n}`);if(owned)target=join(outputs,'packages',owned);}catch{}symlinkSync(target,dst,'dir');}}
 for(const name of packages){const original=join(buildSource,'packages',name),container=join(outputs,'packages',name);if(!existsSync(join(original,'tsconfig.json')))throw Error(`registered runtime adapter missing ${name} tsconfig`);mkdirSync(container,{recursive:true});cpSync(join(original,'package.json'),join(container,'package.json'));symlinkSync(join(original,'src'),join(container,'src'),'dir');for(const name of readdirSync(original)){if(['src','package.json','node_modules','dist','scripts','assets'].includes(name))continue;symlinkSync(join(original,name),join(container,name));}}
 // Make all package roots exist before creating/remapping workspace links.
 for(const candidate of dependencySearch)mapDependencies(candidate,join(outputs,'node_modules'));
 for(const name of packages){const container=join(outputs,'packages',name);mapDependencies(join(toolRoot,'packages',name,'node_modules'),join(container,'node_modules'));const scope=join(container,'node_modules','@proof-or-stop');mkdirSync(scope,{recursive:true});for(const dep of packages){const dst=join(scope,dep==='main'?'core':dep);if(!existsSync(dst))symlinkSync(join(outputs,'packages',dep),dst,'dir');}}
 const privateBin=join(outputs,'node_modules/.bin');mkdirSync(privateBin);symlinkSync(realpathSync(tsc),join(privateBin,'tsc'));
 // Source compiler lookup uses the same private maps, not shared workspace links.
 symlinkSync(join(outputs,'node_modules'),join(buildSource,'node_modules'),'dir');
 for(const name of packages)symlinkSync(join(outputs,'packages',name,'node_modules'),join(buildSource,'packages',name,'node_modules'),'dir');
 const started=Date.now();function run(command,args,cwd,extraEnv={}){const timeout=buildTimeoutMs-(Date.now()-started);if(timeout<=0)throw Error('lane runtime build deadline exceeded');const r=spawnSync('/usr/bin/sandbox-exec',['-p',policy,command,...args],{cwd,env:{...process.env,TMPDIR:temporary,TMP:temporary,TEMP:temporary,...extraEnv},encoding:'utf8',maxBuffer:64*1024*1024,timeout});if(r.status!==0||r.error)throw Error('lane runtime command failed: '+(r.stdout??'')+(r.stderr??'')+(r.error??''));return r.stdout;}
 for(const name of packages){const container=join(outputs,'packages',name),config=join(dirname(buildSource),`${name}.tsconfig.json`),staging=join(container,'dist.staging');
  const options={outDir:staging,tsBuildInfoFile:join(cache,`${name}.tsbuildinfo`),typeRoots:[join(container,'node_modules/@types'),join(outputs,'node_modules/@types')]};
  if(name==='utils')options.paths={'@proof-or-stop/core/extension-api':[join(outputs,'packages/main/dist/extension-api.d.ts')]};
  writeFileSync(config,JSON.stringify({extends:join(buildSource,'packages',name,'tsconfig.json'),compilerOptions:options})+'\n',{flag:'wx'});
  run(process.execPath,[tsc,'-p',config],buildSource);
  if(name==='main')for(const dir of ['core','tasks'])for(const f of readdirSync(join(buildSource,'packages/main/src',dir)))if(/\.(?:m?js|cjs|json)$/.test(f))cpSync(join(buildSource,'packages/main/src',dir,f),join(staging,dir,f));
  if(name==='main')chmodSync(join(staging,'cli.js'),0o755);renameSync(staging,join(container,'dist'));
 }
 const graph=join(outputs,'packages/graph');mkdirSync(join(graph,'scripts'));cpSync(join(buildSource,'packages/graph/scripts/build-web.mjs'),join(graph,'scripts/build-web.mjs'));
 run(process.execPath,[join(graph,'scripts/build-web.mjs')],graph);
 for(const file of ['package.json','bin/bootstrap-runner.js','bin/proof-or-stop.js','scripts/build-lock-target.mjs']){const dst=join(outputs,file);mkdirSync(dirname(dst),{recursive:true});cpSync(join(buildSource,file),dst);}
 // Canonical commands inside the immutable reviewed source resolve the same
 // private runtime. These trusted generated aliases are sealed separately from
 // tracked source bytes and never point at a shared/global dist.
 const sourceRuntimeLinks=[];
 for(const [path,target] of [...packages.map(name=>[`packages/${name}/dist`,join(outputs,'packages',name,'dist')]),['node_modules',join(outputs,'node_modules')],['packages/graph/assets',join(outputs,'packages/graph/assets')]]){
  const destination=join(source,path);try{lstatSync(destination);throw Error(`source runtime path is not fresh: ${path}`);}catch(error){if(error.code!=='ENOENT')throw error;}
  symlinkSync(target,destination,'dir');sourceRuntimeLinks.push({path,target});
 }
 const launchers=join(dirname(buildSource),'launchers');mkdirSync(launchers);
 const launcher=join(launchers,'proof-or-stop');
 const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
 writeFileSync(launcher,`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(source,'bin/proof-or-stop.js'))} "$@"\n`,{flag:'wx',mode:0o755});
 run(process.execPath,[join(source,'bin/proof-or-stop.js'),'--version'],source);
 run(launcher,['--version'],source);
 // Consume real CLI and representative API imports while original runtime reads
 // are denied. A successful compile alone is not a runtime isolation witness.
 run(process.execPath,[join(outputs,'packages/main/dist/cli.js'),'--version'],source);
 const imports=packages.map(n=>JSON.stringify(pathToFileURL(join(outputs,'packages',n,'dist/index.js')).href)).join(',');
 run(process.execPath,['--input-type=module','-e',`for(const path of [${imports}])await import(path);console.log('PRIVATE_RUNTIME_IMPORTS_OK')`],source);
 const h=createHash('sha256');function walk(p){for(const n of readdirSync(p).sort()){const full=join(p,n),st=lstatSync(full);if(st.isSymbolicLink()){h.update(relative(outputs,full)+'\0symlink\0'+readlinkSync(full));}else if(st.isDirectory())walk(full);else{h.update(relative(outputs,full)+'\0file\0');h.update(readFileSync(full));}}}walk(outputs);
 if(digest()!==before)throw Error('source changed during lane build');
 const binding={schema:'managed-review-lane-build.v2',headHash,sourceDigest:before,outputDigest:h.digest('hex'),compilerPath:realpathSync(tsc),compilerFiles,deniedSharedDist:protectedDist,sourceRuntimeLinks,launcherDigest:createHash('sha256').update(readFileSync(launcher)).digest('hex')};
 writeFileSync(join(dirname(buildSource),'build-binding.json'),JSON.stringify(binding)+'\n',{flag:'wx',mode:0o600});return binding;
}
if(process.argv[2]==='--build-lane'){const binding=buildManagedReviewLane(JSON.parse(process.argv[3]));process.stdout.write(JSON.stringify({schema:binding.schema,bindingDigest:createHash('sha256').update(JSON.stringify(binding)+'\n').digest('hex')})+'\n');}
