import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** A disposable runtime owned by this test driver, never a production switch. */
export function createNativeLockTestRuntime(baseEnvironment=process.env) {
 const root=mkdtempSync(join(tmpdir(),'native-lock-runtime-'));
 return {root,env:{...baseEnvironment},dispose(){rmSync(root,{recursive:true,force:true});}};
}
