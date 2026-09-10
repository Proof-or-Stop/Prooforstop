import { parse as parseToml } from 'smol-toml';
import { MANAGED_REVIEW_READONLY_RUNTIME_POLICY } from './runtime-fact-registry.js';
/** Registered file-cache adapter. Never exports a macOS Keychain credential. */
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CLAUDE_NONINTERACTIVE_AUTH_ENV_VARS } from '../providers/claude-cli.js';
export interface ManagedReviewProviderState { host:'codex'|'claude'; directory:string; adapter:'isolated-file-cache-v1' }
const maxFileBytes=MANAGED_REVIEW_READONLY_RUNTIME_POLICY.providerFileMaxBytes;
function inputFile(path:string): boolean {
  if(!existsSync(path))return false;
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maxFileBytes)throw new Error('managed provider config/cache requires bounded regular files');return true;
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
  if(credentialFile)validateInput(host,'credentials',readFileSync(credentials));
  if(configFile)validateInput(host,'configuration',readFileSync(configuration));
  return {host,directory,credentials:credentialFile?credentials:null,configuration:configFile?configuration:null};
}
export function createManagedProviderState(cache:string,host:string,env:NodeJS.ProcessEnv): ManagedReviewProviderState {
  const inputs=preflightManagedProviderState(host,env),directory=join(cache,`provider-${inputs.host}`);
  mkdirSync(directory,{mode:0o700});
  for(const [source,name] of [[inputs.credentials,host==='codex'?'auth.json':'.credentials.json'],[inputs.configuration,host==='codex'?'config.toml':'settings.json']] as const) {
    if(source){if(!inputFile(source))throw new Error('managed provider cache input disappeared');const bytes=readFileSync(source);validateInput(inputs.host,source===inputs.credentials?'credentials':'configuration',bytes);writeFileSync(join(directory,name),bytes,{flag:'wx',mode:0o600});}
  }
  return {host:inputs.host,directory,adapter:MANAGED_REVIEW_READONLY_RUNTIME_POLICY.providerStateAdapter};
}
export function managedProviderStateEnvironment(state:ManagedReviewProviderState):NodeJS.ProcessEnv {
  return state.host==='codex'?{CODEX_HOME:state.directory}:{CLAUDE_CONFIG_DIR:state.directory};
}
