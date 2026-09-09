import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const repo=resolve(process.argv[2]||process.cwd());
const {certifiedTreesEqual,declaredEnvironmentDigest}=await import(pathToFileURL(join(repo,'packages/main/dist/core/story-aware-validation.js')));
const root=mkdtempSync(join(tmpdir(),'u09-proof-boundaries-'));const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();const write=(p,s)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),s)};const commit=()=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture');return git('rev-parse','HEAD')};
const entry={closurePolicy:'static-and-traced'};let checks=0;const check=(label,actual,expected)=>{assert.equal(actual,expected,label);checks++;console.log('PASS '+label)};
const KEY='U09_DECLARED_PROOF_VALUE',odd='./U09_DECLARED_PROOF_VALUE';const oldKey=process.env[KEY],oldOdd=process.env[odd],oldPwd=process.env.PWD;
try{
 git('init','-q','-b','main');git('config','core.filemode','true');write('src/a.ts','export const a=1;\n');write('outside.txt','outside\n');const base=commit();
 const same=(source,head,paths,policy='static-and-traced')=>certifiedTreesEqual(root,source,head,{...entry,closurePolicy:policy},{certifiedPaths:paths});
 check('same full source tree',same(base,base,['src']),true);
 write('src/new.ts','export const n=1;\n');let head=commit();check('directory closure includes newly created descendants',same(base,head,['src']),false);check('glob closure includes newly created descendants',same(base,head,['src/**']),false);check('unaffected exact file positive',same(base,head,['src/a.ts']),true);
 git('checkout','-q','--detach',base);chmodSync(join(root,'src/a.ts'),0o755);head=commit();check('mode-only change invalidates certified file',same(base,head,['src/a.ts']),false);assert.equal(git('rev-parse',base+':src/a.ts'),git('rev-parse',head+':src/a.ts'),'mode fixture has identical blobs');
 git('checkout','-q','--detach',base);git('rm','src/a.ts');head=commit();check('deletion invalidates directory closure',same(base,head,['src']),false);
 git('checkout','-q','--detach',base);write('outside.txt','different\n');head=commit();check('outside change preserves narrow closure',same(base,head,['src']),true);check('whole-repository policy compares all paths',same(base,head,['src'],'whole-repository'),false);check('missing source object is fail closed',same('f'.repeat(40),head,['src']),false);
 const ctx={projectRoot:root,gitCwd:root};const envEntry={declaredEnvironmentKeys:[KEY]};delete process.env[KEY];const absent=declaredEnvironmentDigest(envEntry,ctx);process.env[KEY]='';const empty=declaredEnvironmentDigest(envEntry,ctx);check('absent differs from empty environment',absent===empty,false);process.env[KEY]='A';const a=declaredEnvironmentDigest(envEntry,ctx);process.env[KEY]='B';check('declared inherited value changes digest',a===declaredEnvironmentDigest(envEntry,ctx),false);
 const overlay={...envEntry,env:{[KEY]:'fixed'}};const fixed=declaredEnvironmentDigest(overlay,ctx);process.env[KEY]='C';check('explicit overlay masks inherited changes',fixed===declaredEnvironmentDigest(overlay,ctx),true);
 process.env[KEY]='one';process.env[odd]='different';check('environment key names never path-normalize',declaredEnvironmentDigest({declaredEnvironmentKeys:[KEY]},ctx)===declaredEnvironmentDigest({declaredEnvironmentKeys:[odd]},ctx),false);
 const pwdEntry={declaredEnvironmentKeys:['PWD'],cwd:'src'};process.env.PWD='/unrelated-one';const pwd=declaredEnvironmentDigest(pwdEntry,ctx);process.env.PWD='/unrelated-two';check('PWD uses actual command cwd',pwd===declaredEnvironmentDigest(pwdEntry,ctx),true);
 console.log('PASS U09 actual helper boundaries '+checks+'; this tests real Git projection/environment helpers, not receipt issuance provenance');
}finally{for(const [key,value]of [[KEY,oldKey],[odd,oldOdd],['PWD',oldPwd]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(root,{recursive:true,force:true});}
