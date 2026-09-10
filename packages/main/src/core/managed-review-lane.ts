import { isDeepStrictEqual } from 'node:util';
import { materializeManagedProviderState, managedProviderStateEnvironment, type ManagedReviewProviderState, type ManagedProviderStateSnapshot } from './managed-review-provider-state.js';
import { runValidationCommand } from './validation-executor.js';
import { MANAGED_REVIEW_LANE_ARTIFACT } from './runtime-artifact-registry.js';
import { MANAGED_REVIEW_READONLY_RUNTIME_POLICY } from './runtime-fact-registry.js';
/** Trusted creation side of the managed reviewer lane. No provider code runs here. */
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, realpathSync, readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedReadonlyPolicy, prepareManagedReadonlyLaunch, type ManagedReadonlyLayout } from './managed-review-readonly.js';
const exec = promisify(execFile);
export interface ManagedReviewLane {
  layout: ManagedReadonlyLayout;
  providerState: ManagedReviewProviderState;
  binding: {schema: string; headHash: string; sourceDigest: string; outputDigest: string; compilerPath: string; compilerFiles:Array<{path:string;digest:string}>; deniedSharedDist: string[]; sourceRuntimeLinks:Array<{path:string;target:string}>; launcherDigest:string};
}
export async function createManagedReviewLane(scratch: {parent:string; cwd:string; root:string; headHash:string},host:string,environment:NodeJS.ProcessEnv,providerSeed:ManagedProviderStateSnapshot): Promise<ManagedReviewLane> {
  if (process.platform !== 'darwin') throw new Error('managed readonly platform capability unavailable');
  const lane = join(scratch.parent, MANAGED_REVIEW_LANE_ARTIFACT.directoryName);
  mkdirSync(lane, {mode:0o700});
  const directories = Object.fromEntries([MANAGED_REVIEW_LANE_ARTIFACT.buildSource,MANAGED_REVIEW_LANE_ARTIFACT.temporary,MANAGED_REVIEW_LANE_ARTIFACT.cache,MANAGED_REVIEW_LANE_ARTIFACT.probe].map(name => {
    const p=join(lane,name); mkdirSync(p,{mode:0o700}); return [name,realpathSync(p)];
  })) as Record<string,string>;
  const output=join(scratch.cwd,MANAGED_REVIEW_LANE_ARTIFACT.sourceOutput);
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:scratch.cwd,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
  const rel=MANAGED_REVIEW_LANE_ARTIFACT.sourceOutput;
  if(tracked.some(file=>file===rel||file.startsWith(rel+'/')||rel.startsWith(file+'/')))throw new Error('registered lane output overlaps tracked source');
  let parent=scratch.cwd;
  for(const part of rel.split('/')) {
    parent=join(parent,part);
    try {const stat=lstatSync(parent);if(parent===output||stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(parent)!==parent)throw new Error('lane output parent aliases or output already exists');}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;mkdirSync(parent,{mode:0o700});}
  }
  directories.output=realpathSync(output);
  const providerState=materializeManagedProviderState(directories.cache!,providerSeed);
  if(providerState.host!==host)throw new Error('managed lane seed host mismatch');
  writeFileSync(join(directories.probe!,'.managed-readonly-capability'),'immutable capability probe\n',{flag:'wx',mode:0o400});
  const common=await exec('git',['rev-parse','--git-common-dir'],{cwd:scratch.cwd,encoding:'utf8'});
  const layout: ManagedReadonlyLayout={source:scratch.cwd,buildSource:directories['build-source']!,
    probeRoot:directories.probe!,originalWorktree:scratch.root,
    gitCommonDir:realpathSync(resolve(scratch.cwd,common.stdout.trim())),outputs:[directories.output!],
    temporary:directories.tmp!,cache:directories.cache!};
  // Validate the actual platform before compiling, and again at provider launch.
  prepareManagedReadonlyLaunch(layout,{command:process.execPath,argv:[],cwd:scratch.cwd});
  const toolRoot=realpathSync(fileURLToPath(new URL('../../../../',import.meta.url)));
  const built=await runValidationCommand({label:'managed-review-lane-build',command:process.execPath,
    args:[fileURLToPath(new URL('./managed-review-lane-build.mjs',import.meta.url)),
      '--build-lane',JSON.stringify({source:layout.source,buildSource:layout.buildSource,outputs:layout.outputs[0],
        temporary:layout.temporary,cache:layout.cache,headHash:scratch.headHash,toolRoot,originalWorktree:scratch.root,
        buildTimeoutMs:MANAGED_REVIEW_READONLY_RUNTIME_POLICY.buildTimeoutMs})],
    cwd:lane,timeoutMs:MANAGED_REVIEW_READONLY_RUNTIME_POLICY.buildTimeoutMs + MANAGED_REVIEW_READONLY_RUNTIME_POLICY.builderGraceMs,
    resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'},{class:'machine-process',key:'fanout',access:'exclusive'}],
  },scratch.root,MANAGED_REVIEW_READONLY_RUNTIME_POLICY.buildTimeoutMs,
    {deadlineAt:Date.now()+MANAGED_REVIEW_READONLY_RUNTIME_POLICY.buildTimeoutMs+MANAGED_REVIEW_READONLY_RUNTIME_POLICY.builderGraceMs});
  if(built.code!==0)throw new Error(`managed readonly runtime build failed: ${built.output}`);
  const receipt=JSON.parse(built.output) as {schema:string;bindingDigest:string};
  const bindingBytes=readFileSync(join(lane,MANAGED_REVIEW_LANE_ARTIFACT.binding));
  if(receipt.schema!=='managed-review-lane-build.v2'||createHash('sha256').update(bindingBytes).digest('hex')!==receipt.bindingDigest)throw new Error('managed readonly builder binding receipt mismatch');
  const binding=JSON.parse(bindingBytes.toString('utf8')) as ManagedReviewLane['binding'];
  if(binding.schema!=='managed-review-lane-build.v2'||binding.headHash!==scratch.headHash
    || !/^[0-9a-f]{64}$/.test(binding.sourceDigest)|| !/^[0-9a-f]{64}$/.test(binding.outputDigest)) {
    throw new Error('managed review lane builder returned an invalid binding');
  }
  if(!Array.isArray(binding.deniedSharedDist)||!binding.deniedSharedDist.every(path=>typeof path==='string'))throw new Error('managed build read isolation paths missing');
  layout.deniedSharedDist=binding.deniedSharedDist;
  return {layout,binding,providerState};
}
export function managedReviewLaneEnvironment(lane: ManagedReviewLane): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {TMPDIR:lane.layout.temporary,TMP:lane.layout.temporary,TEMP:lane.layout.temporary,
    XDG_CACHE_HOME:lane.layout.cache,
    PROOF_OR_STOP_REVIEW_BUILD_SOURCE:lane.layout.buildSource,
    PROOF_OR_STOP_REVIEW_BUILD_OUTPUT:join(lane.layout.outputs[0]!,'packages/main/dist')};
  if(Object.keys(environment).sort().join(',')!==[...MANAGED_REVIEW_READONLY_RUNTIME_POLICY.environmentKeys].sort().join(','))throw new Error('managed readonly environment registry mismatch');
  return {...environment,...managedProviderStateEnvironment(lane.providerState)};
}

/** Consume the sealed initial build, never a provider's claim that its outputs match. */
export function verifyManagedReviewLane(lane: ManagedReviewLane, expected: {cwd:string; parent:string; root:string; headHash:string}): void {
  const base=join(expected.parent,MANAGED_REVIEW_LANE_ARTIFACT.directoryName);
  const layout=lane.layout;
  if(layout.source!==expected.cwd||layout.originalWorktree!==expected.root
    ||layout.buildSource!==join(base,MANAGED_REVIEW_LANE_ARTIFACT.buildSource)
    ||layout.outputs.length!==1||layout.outputs[0]!==join(expected.cwd,MANAGED_REVIEW_LANE_ARTIFACT.sourceOutput)
    ||layout.temporary!==join(base,MANAGED_REVIEW_LANE_ARTIFACT.temporary)
    ||layout.cache!==join(base,MANAGED_REVIEW_LANE_ARTIFACT.cache)
    ||layout.probeRoot!==join(base,MANAGED_REVIEW_LANE_ARTIFACT.probe)
    ||lane.binding.headHash!==expected.headHash) throw new Error('managed readonly lane layout differs from sealed scratch');
  if(lane.providerState.directory!==join(layout.cache,`provider-${lane.providerState.host}`)||lane.providerState.adapter!=='isolated-file-cache-v1')throw new Error('managed provider state path changed');
  managedReadonlyPolicy(layout);
  const stored=JSON.parse(readFileSync(join(base,MANAGED_REVIEW_LANE_ARTIFACT.binding),'utf8'));
  if(!isDeepStrictEqual(stored,lane.binding))throw new Error('managed readonly build binding changed');
  for(const link of lane.binding.sourceRuntimeLinks){const full=join(layout.source,link.path);if(!lstatSync(full).isSymbolicLink()||readlinkSync(full)!==link.target)throw new Error('managed source runtime link changed');}
  const launcher=join(base,MANAGED_REVIEW_LANE_ARTIFACT.launchers,'proof-or-stop');
  if(createHash('sha256').update(readFileSync(launcher)).digest('hex')!==lane.binding.launcherDigest)throw new Error('managed readonly PATH launcher changed');
  const files=execFileSync('git',['ls-files','-z'],{cwd:layout.source,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
  for(const root of [layout.source,layout.buildSource]) {
    const h=createHash('sha256');
    for(const file of files){const full=join(root,file),st=lstatSync(full);h.update(file+'\0');
      if(st.isSymbolicLink())h.update('symlink\0'+readlinkSync(full));
      else {if(!st.isFile())throw new Error('managed readonly source contains non-file');h.update('file\0');h.update(readFileSync(full));}}
    if(h.digest('hex')!==lane.binding.sourceDigest)throw new Error('managed readonly source/build source digest changed');
  }
  if(JSON.stringify(layout.deniedSharedDist)!==JSON.stringify(lane.binding.deniedSharedDist))throw new Error('managed readonly shared dist deny paths changed');
  if(!lane.binding.compilerFiles?.length)throw new Error('managed readonly compiler identity missing');
  for(const file of lane.binding.compilerFiles){if(realpathSync(file.path)!==file.path||!lstatSync(file.path).isFile()||createHash('sha256').update(readFileSync(file.path)).digest('hex')!==file.digest)throw new Error('managed readonly compiler identity changed');}
  const dist=layout.outputs[0]!,out=createHash('sha256');
  function walk(path:string):void {for(const name of readdirSync(path).sort()){const full=join(path,name),st=lstatSync(full);
    if(st.isSymbolicLink())out.update(relative(dist,full)+'\0symlink\0'+readlinkSync(full));
    else if(st.isDirectory())walk(full);else {if(!st.isFile())throw new Error('managed readonly compiled output non-file');out.update(relative(dist,full)+'\0file\0');out.update(readFileSync(full));}}}
  walk(dist);if(out.digest('hex')!==lane.binding.outputDigest)throw new Error('managed readonly compiled output differs from sealed build');
}
