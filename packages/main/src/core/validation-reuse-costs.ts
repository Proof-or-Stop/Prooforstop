import {constants,closeSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {PROOF_OR_STOP_STATE_DIR} from './brand-paths.js';

// Advisory execution choice only: no output, receipt, command text or secrets.
const FILE='validation-reuse-costs.json';
const LIMIT=64*1024, TTL=6*60*60*1000;
type Observation={costMs:number;observedAt:number};
function closeObservation(fd:number|undefined):boolean {
  if(fd===undefined)return true;
  try{closeSync(fd);return true;}catch{return false;}
}
function directory(root:string,create=false):string|undefined {
  try {
    let current=realpathSync(root);
    // Index-aware check-ignore also refuses tracked runtime files; never use --no-index.
    if(create) execFileSync('git',['check-ignore','--quiet',`${PROOF_OR_STOP_STATE_DIR}/runtime/`],{cwd:current,stdio:'pipe'});
    for(const name of [PROOF_OR_STOP_STATE_DIR,'runtime']) {
      current=join(current,name);
      if(create){try{mkdirSync(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
      const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())return undefined;
    }
    return current;
  }catch{return undefined;}
}
function read(root:string):Record<string,Observation> {
  const dir=directory(root);if(!dir)return {};
  let fd:number|undefined;
  try {
    fd=openSync(join(dir,FILE),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>LIMIT)return {};
    const bytes=Buffer.alloc(LIMIT+1);let count=0;
    while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
    if(count>LIMIT)return {};
    const value=JSON.parse(bytes.subarray(0,count).toString('utf8'));
    if(value?.schema!==1||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))return {};
    const rows=Object.entries(value.entries);if(rows.length>128)return {};
    const out:Record<string,Observation>={};const now=Date.now();
    for(const [key,raw] of rows){const row=raw as Observation;
      if(!/^[a-f0-9]{64}$/.test(key)||!row||!Number.isFinite(row.costMs)||row.costMs<=0||row.costMs>600000||!Number.isFinite(row.observedAt)||row.observedAt>now||now-row.observedAt>TTL)continue;
      out[key]={costMs:row.costMs,observedAt:row.observedAt};
    }
    return out;
  }catch{return {};}finally{closeObservation(fd);}
}
function digest(key:string):string{return createHash('sha256').update(key).digest('hex');}
export function readValidationReuseCost(root:string,key:string):number|undefined{return read(root)[digest(key)]?.costMs;}
export function saveValidationReuseCost(root:string,key:string,costMs:number|undefined):void {
  const dir=directory(root,true);if(!dir)return;
  const target=join(dir,FILE),temp=join(dir,`${FILE}.${randomUUID()}.tmp`);
  let fd:number|undefined;
  try {
    try {const stat=lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;}
    const entries=read(root),id=digest(key);delete entries[id];
    if(costMs!==undefined&&Number.isFinite(costMs)&&costMs>0&&costMs<=600000)entries[id]={costMs,observedAt:Date.now()};
    const bounded=Object.fromEntries(Object.entries(entries).sort((a,b)=>b[1].observedAt-a[1].observedAt).slice(0,128));
    fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify({schema:1,entries:bounded}));
    const completed=fd;fd=undefined;
    if(!closeObservation(completed))return;
    renameSync(temp,target);
  }catch{/* A missed observation may cost time but must not change execution truth. */}
  finally{closeObservation(fd);try{unlinkSync(temp);}catch{}}
}
