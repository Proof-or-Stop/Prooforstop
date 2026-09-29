import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {executeLabAudit,auditInput} from './lab-audit.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync(join(tmpdir(),'audit-prompt-budget-'));
const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
try {
 git('init','-b','main');git('config','user.name','Audit fixture');git('config','user.email','audit@example.invalid');
 writeFileSync(join(dir,'source.txt'),'old\n');git('add','.');git('commit','-m','baseline');const base=git('rev-parse','HEAD');
 writeFileSync(join(dir,'source.txt'),'new bounded line\n'.repeat(100000));git('add','source.txt');git('commit','-m','large text change');const head=git('rev-parse','HEAD');
 const adapter=join(dir,'adapter.cjs');
 writeFileSync(adapter,`const fs=require('node:fs');const crypto=require('node:crypto');const p=fs.readFileSync(0,'utf8');const binding=JSON.parse(p.split('Binding: ')[1].split('\\nSchema:')[0]);const data=JSON.parse(p.split('Untrusted audit input:\\n')[1]);
 if(typeof data.diff==='object'){const diff=fs.readFileSync(data.diff.snapshot,'utf8');if(crypto.createHash('sha256').update(diff).digest('hex')!==data.diff.sha256)throw Error('diff binding');if(!diff.includes('+new bounded line'))throw Error('missing full diff');}
 for(const f of data.files){const body=fs.readFileSync('snapshot/'+f.path,'utf8');if(body.length<1000000)throw Error('missing full source');}
 if(process.argv[2]==='tamper')fs.appendFileSync(data.diff.snapshot,'tamper');
 if(process.argv[2]==='tamper-file-diff')fs.appendFileSync(data.files[0].diff.snapshot,'tamper');
 console.log(JSON.stringify({...binding,decision:'pass',summary:'Synthetic fixture: transport checks only, not independent provider approval.',readRefs:data.files.map(f=>f.path),findings:[]}));`);
 chmodSync(adapter,0o700);
 const selection={developer:{id:'codex',vendor:'openai'},auditor:{id:'fixture',vendor:'fixture',command:process.execPath,argv:[adapter],protocol:'lab-json'}};
 const options={cwd:root,base,head,developer:'codex',labName:'prompt-fixture',evidenceRoot:join(dir,'evidence'),selection};
 // Commit inputs come from the disposable repository; supervisor uses its own isolated fixture root.
 options.cwd=dir;
 const original=auditInput(dir,base,head);
 const result=await executeLabAudit(options);
 const projected=JSON.parse(readFileSync(join(result.evidenceDir,'prompt.txt'),'utf8').split('Untrusted audit input:\n')[1]);
 assert.ok(projected.files.every(file=>file.diff?.snapshot),'LAB_AUDIT_PER_FILE_DIFF_MISSING: reviewer needs bounded per-file change navigation');
 for(const file of projected.files) assert.equal(readFileSync(join(result.evidenceDir,file.diff.snapshot),'utf8'),git('--literal-pathspecs','diff','--no-ext-diff','--no-textconv',base,head,'--',file.path)+'\n');
 const bytes=Buffer.byteLength(readFileSync(join(result.evidenceDir,'prompt.txt')));
 console.log('LAB_AUDIT_PROMPT_BYTES '+JSON.stringify({inputBytes:Buffer.byteLength(original.input),promptBytes:bytes,inputDigest:result.inputDigest}));
 assert(bytes<65536,'LAB_AUDIT_PROMPT_OVERFLOW: large diff and source must use complete snapshots within the prompt budget');
 assert.equal(result.inputDigest,original.inputDigest);
 await assert.rejects(()=>executeLabAudit({...options,selection:{...selection,auditor:{...selection.auditor,argv:[adapter,'tamper']}}}),/snapshot changed/);
 await assert.rejects(()=>executeLabAudit({...options,selection:{...selection,auditor:{...selection.auditor,argv:[adapter,'tamper-file-diff']}}}),/snapshot changed/);
 console.log('LAB_AUDIT_PROMPT_BUDGET_GREEN complete bytes, digest binding and diff tamper rejection; synthetic transport only');
} finally {rmSync(dir,{recursive:true,force:true});}
