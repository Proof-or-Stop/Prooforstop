import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const runtime=process.env.CHECKPOINT_TEST_RUNTIME??resolve(import.meta.dirname,'../..');
const {signValidationArtifact,verifyValidationArtifacts}=await import(runtime+'/packages/main/dist/core/validation-artifact-signing.js');
const root=mkdtempSync(join(tmpdir(),'signature-key-controls-'));
try{
 execFileSync('git',['init','-q'],{cwd:root});
 const keyPath=join(root,'.git/proof-story-aware-validation-artifact-v1.key');
 assert.deepEqual(verifyValidationArtifacts([{value:1,signature:'sha256:fake'},{value:2,signature:null}],root),[false,false]);assert.equal(existsSync(keyPath),false,'verification never creates a key');
 const values=Array.from({length:5},(_,i)=>({n:i})),entries=values.map(value=>({value,signature:signValidationArtifact(value,root)}));
 const trusted=readFileSync(keyPath);assert.deepEqual(verifyValidationArtifacts(entries,root),[true,true,true,true,true]);
 for(let i=0;i<5;i++){const bad=structuredClone(entries);bad[i].value.n+=10;const expected=Array(5).fill(true);expected[i]=false;assert.deepEqual(verifyValidationArtifacts(bad,root),expected);}
 writeFileSync(keyPath,randomBytes(32).toString('base64'));assert.deepEqual(verifyValidationArtifacts(entries,root),Array(5).fill(false));writeFileSync(keyPath,trusted);
 const changed=structuredClone(entries);Object.defineProperty(changed[0].value,'n',{enumerable:true,get(){writeFileSync(keyPath,randomBytes(32).toString('base64'));return 0;}});
 assert.deepEqual(verifyValidationArtifacts(changed,root),Array(5).fill(false),'mid-batch key replacement invalidates the whole batch');writeFileSync(keyPath,trusted);
 assert.deepEqual(verifyValidationArtifacts(entries,root),Array(5).fill(true));rmSync(keyPath);assert.deepEqual(verifyValidationArtifacts(entries,root),Array(5).fill(false),'no previous-call validation cache');
 assert.deepEqual(verifyValidationArtifacts([],root),[]);console.log('SIGNATURE_KEY_CONTROLS_GREEN: all five signatures checked; missing, rotated, mid-batch changed and deleted keys refused; no key created');
}finally{rmSync(root,{recursive:true,force:true});}
