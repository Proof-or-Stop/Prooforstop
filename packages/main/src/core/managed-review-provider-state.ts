import { parse as parseToml } from 'smol-toml';
import { MANAGED_REVIEW_READONLY_RUNTIME_POLICY } from './runtime-fact-registry.js';
/** Registered file-cache adapter. Never exports a macOS Keychain credential. */
import { constants, openSync, closeSync, fstatSync, readSync, existsSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS } from '../providers/claude-cli.js';
export interface ManagedReviewProviderState { host:'codex'|'claude'; directory:string; adapter:'isolated-file-cache-v1' }
const maxFileBytes=MANAGED_REVIEW_READONLY_RUNTIME_POLICY.providerFileMaxBytes;
function inputFile(path:string): boolean {
  let info;try{info=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>maxFileBytes)throw new Error('managed provider config/cache requires bounded regular files');return true;
}
function record(value:unknown): value is Record<string,unknown> {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function nonempty(value:unknown): value is string {return typeof value==='string'&&value.trim().length>0;}
function validateInput(host:'codex'|'claude',kind:'credentials'|'configuration',bytes:Buffer): void {
  if(bytes.length>maxFileBytes)throw new Error('managed provider config/cache exceeds bounded input');
  let value:unknown;
  try {value=host==='codex'&&kind==='configuration'?parseToml(bytes.toString('utf8')):JSON.parse(bytes.toString('utf8'));}
  catch {throw new Error(`managed ${host} ${kind} syntax invalid`);}
  if(!record(value))throw new Error(`managed ${host} ${kind} must be an object`);
  if(kind==='credentials') {
    const supported=host==='codex'
      ? nonempty(value.OPENAI_API_KEY)||(record(value.tokens)&&nonempty(value.tokens.access_token)&&nonempty(value.tokens.refresh_token)&&nonempty(value.tokens.id_token))
      : record(value.claudeAiOauth)&&nonempty(value.claudeAiOauth.accessToken)&&nonempty(value.claudeAiOauth.refreshToken);
    if(!supported)throw new Error(`managed ${host} credentials have no supported nonempty file-cache shape`);
  } else if(host==='codex'&&value.cli_auth_credentials_store!==undefined&&value.cli_auth_credentials_store!=='file') {
    throw new Error('managed Codex file-cache adapter cannot override a non-file credential-store policy');
  }
}
export function preflightManagedProviderState(host:string,env:NodeJS.ProcessEnv): {host:'codex'|'claude'; directory:string; credentials:string|null; configuration:string|null} {
  if(host!=='codex'&&host!=='claude')throw new Error('managed readonly provider state adapter unsupported');
  const requested=host==='codex'?(env.CODEX_HOME??join(homedir(),'.codex')):(env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'));
  if(!isAbsolute(requested))throw new Error('managed provider configuration directory must be absolute');
  const directory=existsSync(requested)?realpathSync(requested):requested;
  const credentials=join(directory,host==='codex'?'auth.json':'.credentials.json');
  const configuration=join(directory,host==='codex'?'config.toml':'settings.json');
  const credentialFile=inputFile(credentials),configFile=inputFile(configuration);
  const envAuth=host==='claude'&&CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS.some(name=>Boolean(env[name]?.trim()));
  if(!credentialFile&&!envAuth)throw new Error(`managed ${host} isolated cache requires an existing file credential${host==='claude'?' or registered noninteractive credential environment':''}; keyring-only authentication is unsupported because directory isolation changes credential identity`);
  if(credentialFile)captureFile(credentials,host,'credentials');
  if(configFile)captureFile(configuration,host,'configuration');
  return {host,directory,credentials:credentialFile?credentials:null,configuration:configFile?configuration:null};
}
declare const snapshotBrand: unique symbol;
/** Controller-local capability. It cannot be reconstructed from JSON. */
export interface ManagedProviderStateSnapshot { readonly [snapshotBrand]: true }
type CapturedState = { host:'codex'|'claude'; files: Array<{name:string; bytes:Buffer}> };
const capturedStates = new WeakMap<ManagedProviderStateSnapshot, CapturedState>();
function captureFile(path:string,host:'codex'|'claude',kind:'credentials'|'configuration'):Buffer {
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
  for(const [source,name,kind] of [[inputs.credentials,host==='codex'?'auth.json':'.credentials.json','credentials'],[inputs.configuration,host==='codex'?'config.toml':'settings.json','configuration']] as const) {
    if(source)files.push({name,bytes:captureFile(source,inputs.host,kind)});
  }
  const token=Object.freeze({}) as ManagedProviderStateSnapshot;
  capturedStates.set(token,{host:inputs.host,files});return token;
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
  return state.host==='codex'?{CODEX_HOME:state.directory}:{CLAUDE_CONFIG_DIR:state.directory};
}
