import {readObservedExecutableDigest} from './executable-digest-observation.js';
import {statValidatedFileDigest} from './stat-validated-digest.js';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,realpathSync,statSync,type Dirent} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {runtimeDistRoot} from './runtime-layout.js';
import {createRequire} from 'node:module';
import {EXECUTION_IMPLEMENTATION_PIN_POLICY} from './runtime-fact-registry.js';

const sha=(bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Directory listings of earlier scans, reused only while the directory's full
 * stat identity (inode, size, mtime, ctime, mode in nanoseconds) is unchanged on
 * a nanosecond-timestamp filesystem: adding, removing or renaming an entry gives
 * the directory a new mtime/ctime. A whole-second timestamp never reuses (the
 * rule git-ref-witness-memo applies to ref directories). Every scan still stats
 * every directory and every file, so content changes are seen exactly as before;
 * only the identical readdir is skipped. Verification runs scan this identity
 * four times per pinned execution (run 17: 22 executions per batch).
 */
type ListedEntry = {name:string;directory:boolean;file:boolean;symlink:boolean};
const listings=new Map<string,{identity:string;entries:ListedEntry[]}>();
function listDirectory(directory:string):ListedEntry[]{
  const stat=statSync(directory,{bigint:true});
  const identity=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  const fineGrained=stat.mtimeNs%1_000_000_000n!==0n&&stat.ctimeNs%1_000_000_000n!==0n;
  const known=listings.get(directory);
  if(fineGrained&&known&&known.identity===identity)return known.entries;
  const entries=readdirSync(directory,{withFileTypes:true}).map((item:Dirent)=>({name:item.name,directory:item.isDirectory(),file:item.isFile(),symlink:item.isSymbolicLink()}))
    .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if(fineGrained)listings.set(directory,{identity,entries});else listings.delete(directory);
  return entries;
}
interface PackageDescriptor {name?:string;version?:string;dependencies?:Record<string,string>}
/** Content identity of this loaded implementation, not the target project's version. */
export function executionImplementationIdentity() {
  // The runtime root comes from the installation layout, not this module's own
  // URL: inside the CLI bundle import.meta.url is the bundle file in dist/.
  const runtimeRoot=realpathSync(runtimeDistRoot());
  const packageRoot=resolve(runtimeRoot,'..');
  const repositoryRoot=resolve(packageRoot,'../..');
  const files: Array<{path:string;digest:string}>=[];
  const visited=new Set<string>();
  // Every file is read once per synchronous scan: descriptor parsing and content
  // digests consume the same bytes. The directory walk runs every call, so the
  // next scan still observes additions, deletions and symlinks; unchanged file
  // contents reuse a stat-validated digest instead of being hashed again.
  const digests=new Map<string,string>();
  const descriptors=new Map<string,PackageDescriptor>();
  const digestOf=(path:string):string=>{
    const known=digests.get(path);
    if(known!==undefined)return known;
    const digest=statValidatedFileDigest(path);
    digests.set(path,digest);
    return digest;
  };
  const descriptorOf=(path:string):PackageDescriptor=>{
    const known=descriptors.get(path);
    if(known!==undefined)return known;
    const bytes=readFileSync(path);
    if(!digests.has(path))digests.set(path,sha(bytes));
    const descriptor=JSON.parse(bytes.toString('utf8')) as PackageDescriptor;
    descriptors.set(path,descriptor);
    return descriptor;
  };
  const scan=(directory:string,label:string,includeAll=false):void=>{
    if(!existsSync(directory))return;
    const actual=realpathSync(directory);
    if(visited.has(actual))return;visited.add(actual);
    for(const item of listDirectory(actual)){
      if(item.name==='node_modules'||item.name==='.git')continue;
      const path=join(actual,item.name),key=label+'/'+item.name;
      if(item.directory)scan(path,key,includeAll);
      else if(item.file && (includeAll || /\.(?:js|cjs|mjs|ts|json|node)$/.test(item.name)) && !/\.d\.ts$/.test(item.name)) files.push({path:key,digest:digestOf(path)});
      else if(item.symlink)throw new Error('IMPLEMENTATION_IDENTITY_SYMLINK: '+key);
    }
  };
  scan(runtimeRoot,'core');
  // The repository wrapper executes these modules before runCli. Binding only
  // argv[1] misses imported bootstrap bytes while the displayed version stays
  // unchanged. Include the wrapper surface and its dependency-free lock helper;
  // ordinary project verification scripts remain execution inputs, not CLI code.
  scan(join(repositoryRoot,'bin'),'bootstrap');
  const bootstrapLockHelper=join(repositoryRoot,'scripts/build-lock-target.mjs');
  if(existsSync(bootstrapLockHelper)) files.push({path:'bootstrap/build-lock-target.mjs',digest:digestOf(bootstrapLockHelper)});
  scan(join(packageRoot,'templates'),'core/templates',true);
  for(const name of ['utils','lab'])scan(join(repositoryRoot,'packages',name,'dist'),name);
  const packageDescriptor=join(packageRoot,'package.json');
  const pkg=descriptorOf(packageDescriptor);
  files.push({path:'core/package.json',digest:digestOf(packageDescriptor)});
  const packageVisited=new Set<string>();
  const dependencies=(from:string,names:Record<string,string>):void=>{
    const require=createRequire(join(from,'package.json'));
    for(const name of Object.keys(names).sort()){
      let entry:string;
      try{entry=require.resolve(name);}catch(error){
        if ((error as NodeJS.ErrnoException).code!=='MODULE_NOT_FOUND') throw error;
        // Bind absence too: an optional extension becoming available changes identity.
        files.push({path:'unresolved-dependency/'+name,digest:sha('MODULE_NOT_FOUND')});
        continue;
      }
      let directory=dirname(realpathSync(entry));
      while (dirname(directory)!==directory) {
        const path=join(directory,'package.json');
        if (existsSync(path) && descriptorOf(path).name===name) break;
        directory=dirname(directory);
      }
      const descriptor=descriptorOf(join(directory,'package.json'));
      if (descriptor.name!==name) throw new Error('IMPLEMENTATION_DEPENDENCY_ROOT_MISMATCH: '+name);
      if(packageVisited.has(directory))continue;packageVisited.add(directory);
      scan(directory,'dependency/'+name+'@'+descriptor.version);
      dependencies(directory,descriptor.dependencies??{});
    }
  };
  dependencies(packageRoot,pkg.dependencies??{});
  const utilsRoot=join(repositoryRoot,'packages/utils');
  if (existsSync(join(utilsRoot,'package.json'))) dependencies(utilsRoot,descriptorOf(join(utilsRoot,'package.json')).dependencies??{});
  const executable=realpathSync(process.execPath);
  const entrypoint=process.argv[1]?realpathSync(resolve(process.argv[1])):null;
  const runtime={version:process.version,executableDigest:readObservedExecutableDigest(executable),
    entrypointDigest:entrypoint?digestOf(entrypoint):null,
    execArgv:process.execArgv, nodeOptionsDigest:sha(process.env.NODE_OPTIONS??'')};
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const digest=sha(JSON.stringify({schema:EXECUTION_IMPLEMENTATION_PIN_POLICY.schema,runtime,files}));
  return {schema:EXECUTION_IMPLEMENTATION_PIN_POLICY.schema,digest,packageVersion:pkg.version,entrypoint,implementationRoot:runtimeRoot,runtime,fileCount:files.length,files};
}

/** Opt-in transport contract shared by bootstrap, direct global CLI and all roles. */
export function enforceExecutionImplementationPin(): ReturnType<typeof executionImplementationIdentity> | undefined {
  let expected=process.env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST;
  let required=process.env.PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN==='1';
  const manifestPath=process.env.PROOF_OR_STOP_IMPLEMENTATION_MANIFEST;
  if(manifestPath !== undefined) {
    let manifest: {schema?:unknown;digest?:unknown;entrypoint?:unknown;entrypoints?:unknown};
    try { manifest=JSON.parse(readFileSync(manifestPath,'utf8')); }
    catch { throw new Error('IMPLEMENTATION_MANIFEST_UNREADABLE'); }
    if(!manifest || manifest.schema!==EXECUTION_IMPLEMENTATION_PIN_POLICY.sessionSchema ||
       typeof manifest.digest!=='string' || !/^[a-f0-9]{64}$/.test(manifest.digest) ||
       typeof manifest.entrypoint!=='string' || !isAbsolute(manifest.entrypoint))
      throw new Error('IMPLEMENTATION_MANIFEST_INVALID');
    const entries=manifest.entrypoints??[{entrypoint:manifest.entrypoint,digest:manifest.digest}];
    if(!Array.isArray(entries) || entries.length===0 || entries.some(row=>!row ||
       typeof row.entrypoint!=='string' || !isAbsolute(row.entrypoint) ||
       typeof row.digest!=='string' || !/^[a-f0-9]{64}$/.test(row.digest)) ||
       new Set(entries.map(row=>row.entrypoint)).size!==entries.length ||
       !entries.some(row=>row.entrypoint===manifest.entrypoint && row.digest===manifest.digest))
      throw new Error('IMPLEMENTATION_MANIFEST_INVALID');
    const actualEntry=process.argv[1]?realpathSync(resolve(process.argv[1])):null;
    const selected=entries.find(row=>row.entrypoint===actualEntry);
    if(!selected) throw new Error('IMPLEMENTATION_MANIFEST_ENTRYPOINT_MISMATCH');
    if(expected!==undefined && expected!==selected.digest) throw new Error('IMPLEMENTATION_MANIFEST_PIN_CONFLICT');
    expected=selected.digest;
    required=true;
  }
  if(!expected && !required)return undefined;
  if(!expected || !/^[a-f0-9]{64}$/.test(expected))throw new Error('IMPLEMENTATION_PIN_MISSING_OR_INVALID');
  const actual=executionImplementationIdentity();
  if(actual.digest!==expected)throw new Error(`IMPLEMENTATION_PIN_MISMATCH: expected=${expected} actual=${actual.digest} entrypoint=${actual.entrypoint}`);
  if(manifestPath!==undefined) process.stderr.write('IMPLEMENTATION_SESSION_WITNESS '+JSON.stringify({
    schema:EXECUTION_IMPLEMENTATION_PIN_POLICY.witnessSchema,pid:process.pid,digest:actual.digest,
    entrypoint:actual.entrypoint,argvDigest:sha(JSON.stringify(process.argv.slice(2))),
  })+'\n');
  return actual;
}
