import { REVIEWER_BATCH_ADMISSION_ARTIFACT } from './runtime-artifact-registry.js';
import { MANAGED_PROVIDER_SEED_RUNTIME_POLICY as seedPolicy, MANAGED_REVIEW_AUTH_RUNTIME_POLICY as authPolicy } from './runtime-fact-registry.js';
import { managedExecutionKeyedDigest, type ManagedExecutionIdentityKey } from './managed-execution-identity-key.js';
import { randomUUID } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { MANAGED_REVIEW_READONLY_RUNTIME_POLICY } from './runtime-fact-registry.js';
import { execFileSync } from 'node:child_process';
/** Private provider snapshots; only the controller reads the exact Claude login item. */
import { linkSync, unlinkSync, constants, openSync, closeSync, fstatSync, readSync, existsSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS } from '../providers/claude-cli.js';
export interface ManagedReviewProviderState { host:'codex'|'claude'|'grok'; directory:string; adapter:'isolated-file-cache-v1' }
const maxFileBytes=MANAGED_REVIEW_READONLY_RUNTIME_POLICY.providerFileMaxBytes;
function inputFile(path:string): boolean {
  let info;try{info=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>maxFileBytes)throw new Error('managed provider config/cache requires bounded regular files');return true;
}
function record(value:unknown): value is Record<string,unknown> {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function nonempty(value:unknown): value is string {return typeof value==='string'&&value.trim().length>0;}
function validateInput(host:'codex'|'claude'|'grok',kind:'credentials'|'configuration',bytes:Buffer): void {
  if(bytes.length>maxFileBytes)throw new Error('managed provider config/cache exceeds bounded input');
  let value:unknown;
  try {value=host!=='claude'&&kind==='configuration'?parseToml(bytes.toString('utf8')):JSON.parse(bytes.toString('utf8'));}
  catch {throw new Error(`managed ${host} ${kind} syntax invalid`);}
  if(!record(value))throw new Error(`managed ${host} ${kind} must be an object`);
  if(kind==='credentials') {
    const supported=host==='codex'
      ? nonempty(value.OPENAI_API_KEY)||(record(value.tokens)&&nonempty(value.tokens.access_token)&&nonempty(value.tokens.refresh_token)&&nonempty(value.tokens.id_token))
      : host==='grok' ? Object.values(value).some(row=>record(row)&&nonempty(row.key)&&nonempty(row.auth_mode))
      : record(value.claudeAiOauth)&&nonempty(value.claudeAiOauth.accessToken)&&nonempty(value.claudeAiOauth.refreshToken);
    if(!supported)throw new Error(`managed ${host} credentials have no supported nonempty file-cache shape`);
  } else if(host==='codex'&&value.cli_auth_credentials_store!==undefined&&value.cli_auth_credentials_store!=='file') {
    throw new Error('managed Codex file-cache adapter cannot override a non-file credential-store policy');
  }
}
export function preflightManagedProviderState(host:string,env:NodeJS.ProcessEnv): {host:'codex'|'claude'|'grok'; directory:string; credentials:string|null; configuration:string|null; keychain?:true} {
  if(host!=='codex'&&host!=='claude'&&host!=='grok')throw new Error('managed readonly provider state adapter unsupported');
  const requested=host==='codex'?(env.CODEX_HOME??join(homedir(),'.codex')):host==='grok'?(env.GROK_HOME??join(homedir(),'.grok')):(env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'));
  if(!isAbsolute(requested))throw new Error('managed provider configuration directory must be absolute');
  const directory=existsSync(requested)?realpathSync(requested):requested;
  const credentials=join(directory,host==='claude'?'.credentials.json':'auth.json');
  const configuration=join(directory,host==='claude'?'settings.json':'config.toml');
  const credentialFile=inputFile(credentials),configFile=inputFile(configuration);
  if(host==='grok'&&['requirements.toml','managed_config.toml'].some(name=>existsSync(join(directory,name))))throw new Error('managed Grok home policy files require an explicit isolation adapter; refusing to omit them');
  const envAuth=(host==='claude'?CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS:host==='grok'?['XAI_API_KEY']:[]).some(name=>Boolean(env[name]?.trim()));
  const keychain=!credentialFile&&!envAuth&&host==='claude'&&process.platform==='darwin'&&existsSync(join(homedir(),'.claude'))&&directory===realpathSync(join(homedir(),'.claude'));
  if(keychain)captureClaudeKeychain();
  if(!credentialFile&&!envAuth&&!keychain)throw new Error(`managed ${host} isolated cache requires an existing file credential or a registered noninteractive credential environment; Claude Keychain fallback supports only the default macOS configuration directory`);
  if(credentialFile)captureFile(credentials,host,'credentials');
  if(configFile)captureFile(configuration,host,'configuration');
  return {host,directory,credentials:credentialFile?credentials:null,configuration:configFile?configuration:null,...(keychain?{keychain:true as const}:{})};
}
/** Never return provider error output: it may contain credential bytes. No shell or PATH lookup. */
function captureClaudeKeychain():Buffer {
  let raw:Buffer;
  try {raw=execFileSync(authPolicy.keychainExecutable,['find-generic-password','-s',authPolicy.claudeKeychainService,'-w'],
    {timeout:authPolicy.keychainTimeoutMs,maxBuffer:maxFileBytes,stdio:['ignore','pipe','pipe']});}
  catch {throw new Error('managed Claude default Keychain credential unavailable; authenticate with Claude or configure noninteractive credentials');}
  let parsed:unknown;
  try {parsed=JSON.parse(raw.toString('utf8'));}catch {throw new Error('managed Claude Keychain credential syntax invalid');}
  if(!record(parsed)||!record(parsed.claudeAiOauth))throw new Error('managed Claude Keychain OAuth credential missing');
  // MCP OAuth and unrelated account secrets never enter the reviewer snapshot.
  const bytes=Buffer.from(JSON.stringify({claudeAiOauth:parsed.claudeAiOauth}));
  validateInput('claude','credentials',bytes);return bytes;
}
declare const snapshotBrand: unique symbol;
/** Controller-local capability. It cannot be reconstructed from JSON. */
export interface ManagedProviderStateSnapshot { readonly [snapshotBrand]: true }
type CapturedState = { host:'codex'|'claude'|'grok'; files: Array<{name:string; bytes:Buffer}> };
const capturedStates = new WeakMap<ManagedProviderStateSnapshot, CapturedState>();
function captureFile(path:string,host:'codex'|'claude'|'grok',kind:'credentials'|'configuration'):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(!before.isFile()||before.size>maxFileBytes)throw new Error('managed provider config/cache requires bounded regular files');
    const buffer=Buffer.alloc(maxFileBytes+1);let length=0;
    while(length<buffer.length){const count=readSync(fd,buffer,length,buffer.length-length,null);if(count===0)break;length+=count;}
    const after=fstatSync(fd);
    if(length>maxFileBytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('managed provider input changed during capture');
    const bytes=Buffer.from(buffer.subarray(0,length));validateInput(host,kind,bytes);return bytes;
  }finally{closeSync(fd);}
}
export function captureManagedProviderState(host:string,env:NodeJS.ProcessEnv):ManagedProviderStateSnapshot {
  const inputs=preflightManagedProviderState(host,env);
  const files:CapturedState['files']=[];
  if(inputs.keychain)files.push({name:'.credentials.json',bytes:captureClaudeKeychain()});
  for(const [source,name,kind] of [[inputs.credentials,host==='claude'?'.credentials.json':'auth.json','credentials'],[inputs.configuration,host==='claude'?'settings.json':'config.toml','configuration']] as const) {
    if(source)files.push({name,bytes:captureFile(source,inputs.host,kind)});
  }
  if(inputs.host==='grok') {
    const config=files.find(file=>file.name==='config.toml');
    const value=config?parseToml(config.bytes.toString('utf8')):{};
    const cli=record(value.cli)?value.cli:{};
    const bytes=Buffer.from(stringifyToml({...value,cli:{...cli,use_leader:false,auto_update:false}}));
    if(config)config.bytes=bytes;else files.push({name:'config.toml',bytes});
  }
  const token=Object.freeze({}) as ManagedProviderStateSnapshot;
  capturedStates.set(token,{host:inputs.host,files});return token;
}
/** Digest-only controller access; captured credential bytes never leave this module. */
export function fingerprintCapturedManagedProviderState(snapshot:ManagedProviderStateSnapshot,key:ManagedExecutionIdentityKey,expectedHost?:string):string {
  const state=capturedStates.get(snapshot);
  if(!state||expectedHost!==undefined&&state.host!==expectedHost)throw new Error('invalid or mismatched provider snapshot capability');
  const parts:Uint8Array[]=[Buffer.from(state.host)];
  for(const file of [...state.files].sort((a,b)=>a.name.localeCompare(b.name)))parts.push(Buffer.from(file.name),file.bytes);
  return managedExecutionKeyedDigest(key,'managed-provider-state.v1',parts);
}
export function materializeManagedProviderState(cache:string,snapshot:ManagedProviderStateSnapshot):ManagedReviewProviderState {
  const captured=capturedStates.get(snapshot);
  if(!captured)throw new Error('managed provider snapshot is not a captured controller capability');
  const cacheStat=lstatSync(cache);
  if(!cacheStat.isDirectory()||cacheStat.isSymbolicLink())throw new Error('managed provider cache must be a real directory');
  const directory=join(realpathSync(cache),`provider-${captured.host}`);
  mkdirSync(directory,{mode:0o700});
  for(const file of captured.files)writeFileSync(join(directory,file.name),file.bytes,{flag:'wx',mode:0o600});
  return {host:captured.host,directory,adapter:MANAGED_REVIEW_READONLY_RUNTIME_POLICY.providerStateAdapter};
}
export function createManagedProviderState(cache:string,host:string,env:NodeJS.ProcessEnv):ManagedReviewProviderState {
  return materializeManagedProviderState(cache,captureManagedProviderState(host,env));
}
export function managedProviderStateEnvironment(state:ManagedReviewProviderState):NodeJS.ProcessEnv {
  return state.host==='codex'?{CODEX_HOME:state.directory}:state.host==='grok'?{GROK_HOME:state.directory,GROK_DISABLE_AUTOUPDATER:'1'}:{CLAUDE_CONFIG_DIR:state.directory};
}

export interface ManagedProviderSeedBinding {
  subjectIdentity: string;
  generation: number;
  host: 'codex' | 'claude' | 'grok';
}
function seedFile(directory:string,binding:ManagedProviderSeedBinding):string {
  if(!binding.subjectIdentity||!Number.isSafeInteger(binding.generation)||binding.generation<1||!['codex','claude','grok'].includes(binding.host))throw new Error('invalid provider seed binding');
  const info=lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Error('provider seed requires private controller directory');
  return join(realpathSync(directory),`generation-${binding.generation}-${binding.host}${REVIEWER_BATCH_ADMISSION_ARTIFACT.seedFileSuffix}`);
}
/** Trusted producer only: caller captures the probe's refreshed private cache.
 * This stores no READY decision and cannot manufacture admission evidence. */
export function persistCapturedManagedProviderSeed(directory:string,snapshot:ManagedProviderStateSnapshot,key:ManagedExecutionIdentityKey,binding:ManagedProviderSeedBinding):void {
  const state=capturedStates.get(snapshot);
  if(!state||state.host!==binding.host)throw new Error('invalid or mismatched provider snapshot capability');
  const file=seedFile(directory,binding);
  const body={schema:'managed-provider-seed.v1',binding:{subjectIdentity:binding.subjectIdentity,generation:binding.generation,host:binding.host},files:state.files.map(file=>({name:file.name,base64:file.bytes.toString('base64')}))};
  const serialized=JSON.stringify(body);
  const signature=managedExecutionKeyedDigest(key,'managed-provider-seed.v1',[Buffer.from(serialized)]);
  const temporary=file+'.'+randomUUID();
  try {
    writeFileSync(temporary,JSON.stringify({serialized,signature}),{flag:'wx',mode:0o600});
    linkSync(temporary,file); // Exclusive publication: immutable generation/host seed.
  }finally{try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
/** Read-only cross-process load; never reopens original provider credentials. */
export function readCapturedManagedProviderSeed(directory:string,key:ManagedExecutionIdentityKey,binding:ManagedProviderSeedBinding):ManagedProviderStateSnapshot {
  const file=seedFile(directory,binding),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes:Buffer;
  try {
    const before=fstatSync(fd),limit=seedPolicy.encodedFileMultiplier*maxFileBytes+seedPolicy.envelopeAllowanceBytes;
    if(!before.isFile()||before.size>limit||before.nlink!==1||(before.mode&0o077)!==0||before.uid!==process.getuid?.())throw new Error('invalid provider seed file');
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const count=readSync(fd,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}
    const after=fstatSync(fd);
    if(length>limit||length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.mode!==after.mode||before.nlink!==after.nlink)throw new Error('provider seed changed during read');
    bytes=Buffer.from(buffer.subarray(0,length));
  }finally{closeSync(fd);}
  const envelope=JSON.parse(bytes.toString('utf8'));
  if(typeof envelope.serialized!=='string'||typeof envelope.signature!=='string'||managedExecutionKeyedDigest(key,'managed-provider-seed.v1',[Buffer.from(envelope.serialized)])!==envelope.signature)throw new Error('provider seed integrity mismatch');
  const body=JSON.parse(envelope.serialized);
  if(body.schema!=='managed-provider-seed.v1'||body.binding?.subjectIdentity!==binding.subjectIdentity||body.binding?.generation!==binding.generation||body.binding?.host!==binding.host||!Array.isArray(body.files)||body.files.length>seedPolicy.maxFiles)throw new Error('provider seed binding mismatch');
  const allowed=binding.host==='claude'?['.credentials.json','settings.json']:['auth.json','config.toml'];
  const names=new Set<string>();const files:CapturedState['files']=[];
  for(const file of body.files){
    if(!file||!allowed.includes(file.name)||names.has(file.name)||typeof file.base64!=='string')throw new Error('invalid provider seed entry');
    const content=Buffer.from(file.base64,'base64');
    if(content.length>maxFileBytes||content.toString('base64')!==file.base64)throw new Error('invalid provider seed encoding');
    validateInput(binding.host,file.name===allowed[0]?'credentials':'configuration',content);
    names.add(file.name);files.push({name:file.name,bytes:content});
  }
  if(binding.host==='codex'&&!names.has('auth.json'))throw new Error('provider seed missing credentials');
  const token=Object.freeze({}) as ManagedProviderStateSnapshot;capturedStates.set(token,{host:binding.host,files});return token;
}
