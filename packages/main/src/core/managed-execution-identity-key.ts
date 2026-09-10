import { REVIEWER_BATCH_ADMISSION_ARTIFACT } from './runtime-artifact-registry.js';
import { MANAGED_EXECUTION_IDENTITY_RUNTIME_POLICY as policy } from './runtime-fact-registry.js';
import {createHmac,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readSync,writeFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
declare const keyBrand:unique symbol;
export interface ManagedExecutionIdentityKey {readonly [keyBrand]:true}
const keys=new WeakMap<ManagedExecutionIdentityKey,Buffer>();
/** Caller must supply a controller-owned directory excluded from provider mounts. */
function assertPrivateDirectory(directory:string):void {
 const dir=lstatSync(directory);
 if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())throw new Error('identity key requires private controller directory');
}
/** Status/consumers never create a missing key or directory. */
export function readManagedExecutionIdentityKey(directory:string):ManagedExecutionIdentityKey {
 assertPrivateDirectory(directory);
 const fd=openSync(join(directory,REVIEWER_BATCH_ADMISSION_ARTIFACT.identityKeyFile),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let bytes:Buffer;
 try{
  const before=fstatSync(fd);
  if(!before.isFile()||before.size!==policy.keyBytes||before.nlink!==1||(before.mode&0o077)!==0||before.uid!==process.getuid?.())throw new Error('invalid controller identity key');
  const buffer=Buffer.alloc(policy.keyBytes+1);let length=0;
  while(length<buffer.length){const count=readSync(fd,buffer,length,buffer.length-length,null);if(count===0)break;length+=count;}
  const after=fstatSync(fd);
  if(length!==policy.keyBytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.mode!==after.mode||before.nlink!==after.nlink)throw new Error('identity key changed');
  bytes=Buffer.from(buffer.subarray(0,length));
 }finally{closeSync(fd);}
 const token=Object.freeze({}) as ManagedExecutionIdentityKey;keys.set(token,bytes);return token;
}
/** Producer-only creation. Atomic exclusive creation never overwrites an existing key. */
export function loadManagedExecutionIdentityKey(directory:string):ManagedExecutionIdentityKey {
 assertPrivateDirectory(directory);
 const path=join(directory,REVIEWER_BATCH_ADMISSION_ARTIFACT.identityKeyFile);
 try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);try{writeFileSync(fd,randomBytes(policy.keyBytes));}finally{closeSync(fd);}}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 return readManagedExecutionIdentityKey(directory);
}
export function managedExecutionKeyedDigest(key:ManagedExecutionIdentityKey,domain:string,parts:readonly Uint8Array[]):string {
 const secret=keys.get(key);if(!secret)throw new Error('invalid controller identity key capability');
 const hmac=createHmac('sha256',secret);hmac.update(domain+'\0');
 for(const part of parts){hmac.update(String(part.byteLength)+':');hmac.update(part);}
 return 'hmac-sha256:'+hmac.digest('hex');
}
