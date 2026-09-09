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
function commonDirectory(gitCwd:string):string|undefined {
  const cwd=resolve(gitCwd);
  let common=commonDirs.get(cwd);
  if (!common) {
    try {common=resolve(cwd,execFileSync('git',['rev-parse','--git-common-dir'],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());}
    catch {return undefined;} // Legacy non-Git projects cannot create signed amendments.
    commonDirs.set(cwd,common);
  }
  return common;
}
function checkpointPath(storyId:string,gitCwd:string):string|undefined {
  const common=commonDirectory(gitCwd);
  return common?join(common,INTENT_CHECKPOINT_DIRECTORY,digestCanonicalJson(storyId)):undefined;
}
const anchorRef=(storyId:string)=>'refs/proof-or-stop/intent-checkpoints/'+digestCanonicalJson(storyId);
function checkpointGit(gitCwd:string,args:string[],input?:string):string {
  return execFileSync('git',args,{cwd:gitCwd,input,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
}
function validateCheckpoint(record:IntentCheckpoint,storyId:string,gitCwd:string):IntentCheckpoint {
  const {signature,...payload}=record;
  if(record.schema!=='proof-or-stop.intent-checkpoint.v1'||record.storyId!==storyId||!Number.isSafeInteger(record.generation)||record.generation<1
    ||record.dataDigest!==digestCanonicalJson(record.data)||!verifyValidationArtifact(payload,signature,gitCwd))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_INVALID');
  for(const item of record.data.items)assertIntentAmendments(item,storyId,gitCwd);
  return record;
}
interface CheckpointAnchor {commit:string;records:IntentCheckpoint[]}
function assertCheckpointChain(records:IntentCheckpoint[]):void {
  for(let index=0;index<records.length;index++){
    const record=records[index];
    if(record.generation!==index+1)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_HISTORY_GAP');
    if(record.previousDigest!==(records[index-1]?.dataDigest??null))throw new IntentAmendmentIntegrityError(index?'AMENDMENT_CHECKPOINT_PREDECESSOR_MISMATCH':'AMENDMENT_CHECKPOINT_FIRST_PREDECESSOR');
  }
}
/** Resolve refs through Git's backend-neutral API. No loose/packed-file shortcut:
 * the same authority must survive reftable creation and in-place ref migration. */
function readAnchor(storyId:string,gitCwd:string):CheckpointAnchor|null {
  if(!commonDirectory(gitCwd))return null;
  try {
    const ref=anchorRef(storyId);
    const refs=checkpointGit(gitCwd,['for-each-ref','--format=%(refname) %(objectname)',ref]);
    const match=refs.split('\n').find(line=>line.startsWith(ref+' '));if(!match)return null;
    const commit=match.slice(ref.length+1);
    const chain=checkpointGit(gitCwd,['log','--first-parent','--format=%H%x00%P',commit,'--']).split('\n').map(line=>line.split('\0'));
    for(let i=0;i<chain.length;i++){
      const parents=chain[i][1]?.split(' ').filter(Boolean)??[];
      if(parents.length>1||parents[0]!==chain[i+1]?.[0])throw new Error('checkpoint anchors must form a complete single-parent chain');
    }
    // Batch payload reads; byte lengths, not character counts, delimit Unicode JSON.
    const output=execFileSync('git',['cat-file','--batch'],{cwd:gitCwd,input:chain.map(([id])=>id+':checkpoint.json\n').join(''),maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
    let offset=0;const records:IntentCheckpoint[]=[];
    for(const _ of chain){
      const end=output.indexOf(10,offset);if(end<0)throw new Error('missing checkpoint object header');
      const header=output.subarray(offset,end).toString('utf8').match(/^[a-f0-9]+ blob (\d+)$/);if(!header)throw new Error('missing or invalid checkpoint blob');
      const size=Number(header[1]);offset=end+1;
      if(!Number.isSafeInteger(size)||size<0||offset+size>=output.length||output[offset+size]!==10)throw new Error('truncated checkpoint blob');
      records.push(validateCheckpoint(JSON.parse(output.subarray(offset,offset+size).toString('utf8')),storyId,gitCwd));offset+=size+1;
    }
    if(offset!==output.length)throw new Error('unexpected checkpoint object output');
    records.reverse();assertCheckpointChain(records);return {commit,records};
  }catch(error){if(error instanceof IntentAmendmentIntegrityError)throw error;throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_ANCHOR_INVALID',String(error));}
}
function mirrorRecords(storyId:string,gitCwd:string,anchored?:IntentCheckpoint[]):IntentCheckpoint[] {
  const directory=checkpointPath(storyId,gitCwd);if(!directory||!existsSync(directory))return [];
  try {
    const files=readdirSync(directory).filter(name=>/^\d{12}\.json$/.test(name)).sort();
    if(!files.length&&!anchored)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_HISTORY_MISSING');
    const records=files.map(name=>{
      const record=JSON.parse(readFileSync(join(directory,name),'utf8')) as IntentCheckpoint;
      if(record.generation!==Number(name.slice(0,12)))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_GENERATION_MISMATCH');
      if(anchored){
        const authoritative=anchored[record.generation-1];
        if(!authoritative){validateCheckpoint(record,storyId,gitCwd);throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_ROLLBACK','a signed mirror is newer than the retained Git anchor');}
        if(digestCanonicalJson(record)!==digestCanonicalJson(authoritative))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_MIRROR_CONFLICT');
        return authoritative; // Exact bytes of the already verified signed record.
      }
      return validateCheckpoint(record,storyId,gitCwd);
    });
    if(!anchored)assertCheckpointChain(records);return records;
  }catch(error){if(error instanceof IntentAmendmentIntegrityError)throw error;throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_CORRUPT',String(error));}
}
function checkpointState(storyId:string,gitCwd:string):{anchor:CheckpointAnchor|null;records:IntentCheckpoint[]} {
  const anchor=readAnchor(storyId,gitCwd);
  const mirror=mirrorRecords(storyId,gitCwd,anchor?.records);
  return {anchor,records:anchor?.records??mirror};
}
/** Build a complete chain and publish it with one CAS. Migration never exposes a
 * truncated generation>1 root, and a losing writer cannot replace newer truth. */
function writeAnchor(storyId:string,records:IntentCheckpoint[],gitCwd:string,previousCommit?:string):void {
  try {
    let commit=previousCommit;
    for(const record of records){
      const blob=checkpointGit(gitCwd,['hash-object','-w','--stdin'],JSON.stringify(record)+'\n');
      const tree=checkpointGit(gitCwd,['mktree'],'100644 blob '+blob+'\tcheckpoint.json\n');
      commit=checkpointGit(gitCwd,['-c','user.name=Proof-or-Stop checkpoint','-c','user.email=checkpoint@proof-or-stop.local','commit-tree',tree,...(commit?['-p',commit]:[])],
        'Preserve signed acceptance checkpoint generation '+record.generation+'\n');
    }
    if(!commit)throw new Error('empty checkpoint anchor publication');
    checkpointGit(gitCwd,['update-ref',anchorRef(storyId),commit,previousCommit??'0'.repeat(commit.length)]);
  }catch(error){throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_ANCHOR_WRITE_FAILED',String(error));}
}
function reconcileMirror(directory:string,records:IntentCheckpoint[]):void {
  try {
    mkdirSync(directory,{recursive:true});
    for(const record of records){
      const path=join(directory,String(record.generation).padStart(12,'0')+'.json');
      if(existsSync(path)){
        if(digestCanonicalJson(JSON.parse(readFileSync(path,'utf8')))!==digestCanonicalJson(record))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_MIRROR_CONFLICT');
        continue;
      }
      const temp=path+'.'+randomUUID()+'.tmp';
      try{
        writeFileSync(temp,JSON.stringify(record,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
        try{linkSync(temp,path);}catch(error){
          if((error as NodeJS.ErrnoException).code!=='EEXIST'||digestCanonicalJson(JSON.parse(readFileSync(path,'utf8')))!==digestCanonicalJson(record))throw error;
        }
      }finally{if(existsSync(temp))unlinkSync(temp);}
    }
  }catch(error){if(error instanceof IntentAmendmentIntegrityError)throw error;throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_MIRROR_WRITE_FAILED',String(error));}
}
export function readIntentCheckpoint(storyId:string,gitCwd:string):IntentCheckpoint|null {
  return checkpointState(storyId,gitCwd).records.at(-1)??null;
}
export function assertIntentCheckpointProjection(data:ChecklistData,checkpoint:IntentCheckpoint|null):void {
  if(checkpoint && checkpoint.dataDigest!==digestCanonicalJson(data))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_PROJECTION_MISMATCH','use verification_intent_recover to restore the signed checkpoint; no requirement or evidence is silently discarded');
  if(!checkpoint && data.items.some(item=>item.verificationIntentAmendments!==undefined))throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_MISSING');
}
/** Write-ahead checkpoint. Every canonical write also migrates legacy history
 * and repairs missing mirror generations, even when acceptance data is unchanged. */
export function writeIntentCheckpoint(storyId:string,data:ChecklistData,gitCwd:string):void {
  const {anchor,records}=checkpointState(storyId,gitCwd);const previous=records.at(-1);
  if(!previous&&!data.items.some(item=>item.verificationIntentAmendments?.length))return;
  const directory=checkpointPath(storyId,gitCwd);if(!directory)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKPOINT_GIT_REQUIRED');
  const dataDigest=digestCanonicalJson(data);
  if(previous?.dataDigest===dataDigest){
    if(!anchor)writeAnchor(storyId,records,gitCwd);
    reconcileMirror(directory,records);return;
  }
  const payload={schema:'proof-or-stop.intent-checkpoint.v1' as const,storyId,generation:(previous?.generation??0)+1,
    previousDigest:previous?.dataDigest??null,data:structuredClone(data),dataDigest};
  const record={...payload,signature:signValidationArtifact(payload,gitCwd)};
  const complete=[...records,record];
  // Legacy migration and a new generation become authoritative atomically.
  writeAnchor(storyId,anchor?[record]:complete,gitCwd,anchor?.commit);
  reconcileMirror(directory,complete);
}
