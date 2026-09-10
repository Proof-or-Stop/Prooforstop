import { MANAGED_EXECUTION_IDENTITY_RUNTIME_POLICY as policy } from './runtime-fact-registry.js';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readSync,realpathSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {canonicalReviewHostLauncherSpec,type CanonicalReviewHost} from './host-execution-readiness.js';
import {fingerprintCapturedManagedProviderState,type ManagedProviderStateSnapshot} from './managed-review-provider-state.js';
import {managedExecutionKeyedDigest,type ManagedExecutionIdentityKey} from './managed-execution-identity-key.js';
function executable(path:string) {
 if(!isAbsolute(path))throw new Error('execution identity requires explicitly resolved executable path');
 const physical=realpathSync(path),fd=openSync(physical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd);if(!before.isFile()||(before.mode&0o111)===0)throw new Error('execution identity requires executable regular file');
  const hash=createHash('sha256'),buffer=Buffer.alloc(policy.readChunkBytes);let bytes=0;
  for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;if(bytes===0&&buffer[0]===35&&buffer[1]===33)throw new Error('script interpreter chain identity unavailable');bytes+=n;if(bytes>policy.maxExecutableBytes)throw new Error('executable identity exceeds bound');hash.update(buffer.subarray(0,n));}
  const after=fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes!==after.size||realpathSync(path)!==physical)throw new Error('executable changed during identity capture');
  return {requested:path,physical,mode:after.mode,bytes:hash.digest('hex')};
 }finally{closeSync(fd);}
}
/** Full effective env is caller-resolved once; no transport keys or private paths excluded. */
interface RuntimeInputs {key:ManagedExecutionIdentityKey;host:CanonicalReviewHost;executablePath:string;cwd:string;environment:NodeJS.ProcessEnv;reviewProfile:string;reviewArgv:readonly string[]}
export function identifyManagedExecutionRuntimeInputs(args:RuntimeInputs) {
 if(!args.reviewProfile.trim())throw new Error('review profile identity required');
 const environment=Object.keys(args.environment).sort().map(name=>[name,args.environment[name]===undefined?{absent:true}:{value:args.environment[name]}]);
 const projection={schema:'managed-execution-runtime-inputs.v1',host:args.host,launcher:canonicalReviewHostLauncherSpec(args.host),reviewProfile:args.reviewProfile,reviewArgv:[...args.reviewArgv],cwd:realpathSync(args.cwd),environment,executable:executable(args.executablePath),runtime:{node:process.version,platform:process.platform,arch:process.arch,probeAndRunner:['./host-execution-readiness.js','../providers/supervised-process.js','../providers/supervised-process-worker.js','./runtime-fact-registry.js'].map(path=>[path,createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex')])}};
 return Object.freeze({schema:projection.schema,digest:managedExecutionKeyedDigest(args.key,projection.schema,[Buffer.from(JSON.stringify(projection))])});
}

/** Original credential state remains bound at admission, independently of refreshed seeds. */
export function identifyManagedExecutionInputs(args:RuntimeInputs & {providerState:ManagedProviderStateSnapshot}) {
 const runtime=identifyManagedExecutionRuntimeInputs(args);
 const projection={schema:'managed-execution-inputs.v2',runtimeDigest:runtime.digest,providerState:fingerprintCapturedManagedProviderState(args.providerState,args.key,args.host)};
 return Object.freeze({schema:projection.schema,runtimeDigest:runtime.digest,digest:managedExecutionKeyedDigest(args.key,projection.schema,[Buffer.from(JSON.stringify(projection))])});
}
