import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Private OS-user namespace for disposable fixture children only. The real Lab
 * and its Claude audit never receive this environment or a production bypass. */
export function createNativeLockTestRuntime(baseEnvironment=process.env) {
 const root=mkdtempSync(join(tmpdir(),'native-lock-runtime-'));
 try {
  const home=join(root,'home');mkdirSync(home,{mode:0o700});
  const bootstrap=join(root,'fixture-os-user.mjs');
  writeFileSync(bootstrap,`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(home)}});syncBuiltinESMExports();`);
  // NODE_OPTIONS propagates the same namespace to actual CLI descendants; an
  // in-process override alone would leave those children in the real pool.
  const env={...baseEnvironment,NODE_OPTIONS:[baseEnvironment.NODE_OPTIONS??'','--import='+JSON.stringify(bootstrap)].join(' ').trim()};
  return {root,env,dispose(){rmSync(root,{recursive:true,force:true});}};
 } catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}
