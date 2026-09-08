import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {EXECUTION_IMPLEMENTATION_PIN_POLICY} from './runtime-fact-registry.js';

const sha=(bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Content identity of this loaded implementation, not the target project's version. */
export function executionImplementationIdentity() {
  const modulePath=realpathSync(fileURLToPath(import.meta.url));
  const runtimeRoot=resolve(dirname(modulePath),'..');
  const packageRoot=resolve(runtimeRoot,'..');
  const repositoryRoot=resolve(packageRoot,'../..');
  const files: Array<{path:string;digest:string}>=[];
  const visited=new Set<string>();
  const scan=(directory:string,label:string):void=>{
    if(!existsSync(directory))return;
    const actual=realpathSync(directory);
    if(visited.has(actual))return;visited.add(actual);
    for(const item of readdirSync(actual,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      if(item.name==='node_modules'||item.name==='.git')continue;
      const path=join(actual,item.name),key=label+'/'+item.name;
      if(item.isDirectory())scan(path,key);
      else if(item.isFile() && /\.(?:js|cjs|mjs|ts|json|node)$/.test(item.name) && !/\.d\.ts$/.test(item.name)) files.push({path:key,digest:sha(readFileSync(path))});
      else if(item.isSymbolicLink())throw new Error('IMPLEMENTATION_IDENTITY_SYMLINK: '+key);
    }
  };
  scan(runtimeRoot,'core');
  for(const name of ['utils','lab'])scan(join(repositoryRoot,'packages',name,'dist'),name);
  const pkg=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
  files.push({path:'core/package.json',digest:sha(readFileSync(join(packageRoot,'package.json')))});
  const packageVisited=new Set<string>();
  const dependencies=(from:string,names:Record<string,string>):void=>{
    const require=createRequire(join(from,'package.json'));
    for(const name of Object.keys(names).sort()){
      if(name.startsWith('@proof-or-stop/'))continue; // workspace implementations scanned above
      let entry:string;
      try{entry=require.resolve(name);}catch{throw new Error('IMPLEMENTATION_DEPENDENCY_UNRESOLVED: '+name);}
      let directory=dirname(realpathSync(entry));
      while(!existsSync(join(directory,'package.json')) && dirname(directory)!==directory)directory=dirname(directory);
      const descriptor=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
      if(packageVisited.has(directory))continue;packageVisited.add(directory);
      scan(directory,'dependency/'+name+'@'+descriptor.version);
      dependencies(directory,descriptor.dependencies??{});
    }
  };
  dependencies(packageRoot,pkg.dependencies??{});
  const executable=realpathSync(process.execPath);
  const runtime={version:process.version,executableDigest:sha(readFileSync(executable))};
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const digest=sha(JSON.stringify({schema:EXECUTION_IMPLEMENTATION_PIN_POLICY.schema,runtime,files}));
  return {schema:EXECUTION_IMPLEMENTATION_PIN_POLICY.schema,digest,packageVersion:pkg.version,entrypoint:process.argv[1]?realpathSync(resolve(process.argv[1])):null,implementationRoot:runtimeRoot,runtime,fileCount:files.length,files};
}

/** Opt-in transport contract shared by bootstrap, direct global CLI and all roles. */
export function enforceExecutionImplementationPin(): ReturnType<typeof executionImplementationIdentity> | undefined {
  const expected=process.env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST;
  const required=process.env.PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN==='1';
  if(!expected && !required)return undefined;
  if(!expected || !/^[a-f0-9]{64}$/.test(expected))throw new Error('IMPLEMENTATION_PIN_MISSING_OR_INVALID');
  const actual=executionImplementationIdentity();
  if(actual.digest!==expected)throw new Error(`IMPLEMENTATION_PIN_MISMATCH: expected=${expected} actual=${actual.digest} entrypoint=${actual.entrypoint}`);
  return actual;
}
