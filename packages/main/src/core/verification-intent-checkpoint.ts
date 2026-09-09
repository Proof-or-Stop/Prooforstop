import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,linkSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ChecklistData} from './types.js';
import {digestCanonicalJson} from './digest.js';
import {signValidationArtifact,verifyValidationArtifact} from './validation-artifact-signing.js';
import {assertIntentAmendments,IntentAmendmentIntegrityError} from './verification-intent-amendment.js';

/** Durable process evidence in shared Git metadata; never a disposable runtime cache. */
export const INTENT_CHECKPOINT_DIRECTORY = 'proof-or-stop-intent-checkpoints';
export interface IntentCheckpoint {
  schema:'proof-or-stop.intent-checkpoint.v1'; storyId:string; generation:number;
  previousDigest:string|null; data:ChecklistData; dataDigest:string; signature:string;
}
const commonDirs=new Map<string,string>();
function checkpointPath(storyId:string,gitCwd:string):string|undefined {
  const cwd=resolve(gitCwd);
  let common=commonDirs.get(cwd);
  if (!common) {
    try {common=resolve(cwd,execFileSync('git',['rev-parse','--git-common-dir'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());}
    catch {return undefined;} // Legacy non-Git projects cannot create signed amendments.
    commonDirs.set(cwd,common);
  }
  return join(common,INTENT_CHECKPOINT_DIRECTORY,digestCanonicalJson(storyId));
}
export function readIntentCheckpoint(storyId:string,gitCwd:string):IntentCheckpoint|null {
  const directory=checkpointPath(storyId,gitCwd);if(!directory || !existsSync(directory))return null;
  const files=readdirSync(directory).filter(name=>/^\d{12}\.json$/.test(name)).sort();
  if(!files.length)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_HISTORY_MISSING');
  if(files.some((name,index)=>Number(name.slice(0,12))!==index+1))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_HISTORY_GAP');
  const path=join(directory,files.at(-1)!);
  let record:IntentCheckpoint;
  try {record=JSON.parse(readFileSync(path,'utf8'));}catch {throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_CORRUPT');}
  const {signature,...payload}=record;
  if(record.schema!=='proof-or-stop.intent-checkpoint.v1'||record.storyId!==storyId||!Number.isSafeInteger(record.generation)||record.generation<1
    ||record.dataDigest!==digestCanonicalJson(record.data)||!verifyValidationArtifact(payload,signature,gitCwd))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_INVALID');
  if(record.generation!==files.length)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_GENERATION_MISMATCH');
  if(record.generation>1){let previous:IntentCheckpoint;try{previous=JSON.parse(readFileSync(join(directory,files.at(-2)!),'utf8'));}catch{throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_HISTORY_CORRUPT');}
    if(record.previousDigest!==previous.dataDigest || previous.dataDigest!==digestCanonicalJson(previous.data))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_PREDECESSOR_MISMATCH');}
  else if(record.previousDigest!==null)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_FIRST_PREDECESSOR');
  for(const item of record.data.items)assertIntentAmendments(item,storyId,gitCwd);
  return record;
}
export function assertIntentCheckpointProjection(data:ChecklistData,checkpoint:IntentCheckpoint|null):void {
  if(checkpoint && checkpoint.dataDigest!==digestCanonicalJson(data))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_PROJECTION_MISMATCH','use verification_intent_recover to restore the signed checkpoint; no requirement or evidence is silently discarded');
  if(!checkpoint && data.items.some(item=>item.verificationIntentAmendments!==undefined))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_MISSING');
}
/** Write-ahead checkpoint: interrupted projection is recoverable from one signed snapshot. */
export function writeIntentCheckpoint(storyId:string,data:ChecklistData,gitCwd:string):void {
  const previous=readIntentCheckpoint(storyId,gitCwd);
  if(!previous && !data.items.some(item=>item.verificationIntentAmendments?.length))return;
  const dataDigest=digestCanonicalJson(data);if(previous?.dataDigest===dataDigest)return;
  const directory=checkpointPath(storyId,gitCwd);if(!directory)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_GIT_REQUIRED');
  const payload={schema:'proof-or-stop.intent-checkpoint.v1' as const,storyId,generation:(previous?.generation??0)+1,
    previousDigest:previous?.dataDigest??null,data:structuredClone(data),dataDigest};
  const record={...payload,signature:signValidationArtifact(payload,gitCwd)};
  mkdirSync(directory,{recursive:true});const path=join(directory,String(record.generation).padStart(12,'0')+'.json');const temp=path+'.'+randomUUID()+'.tmp';
  try {writeFileSync(temp,JSON.stringify(record,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});linkSync(temp,path);}
  finally {if(existsSync(temp))unlinkSync(temp);}
}
