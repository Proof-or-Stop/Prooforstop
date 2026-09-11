import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
const repo=process.cwd(), selected=process.argv[2];
const rows=[];
for(const kind of ['configured','legacy','warning','gate','legacy-semantic']) for(const fails of kind==='warning'?[false]:['gate','legacy-semantic'].includes(kind)?[true]:[false,true]) for(const json of kind==='legacy-semantic'?[true]:[true,false]) {
 const name=`${kind}-${fails?'fail':'pass'}-${json?'json':'text'}`;if(selected&&selected!==name)continue;
 const root=mkdtempSync(join(tmpdir(),'pos-validation-exit-'));
 try {
  const code=kind==='legacy-semantic'?`console.log(JSON.stringify({provider:'test-validator',status:'pass',allPassed:false}));`:`console.log('USER_OUTPUT: ${fails?'All tests passed':'Validation failed'} (non-authoritative text)');process.exitCode=${fails?7:0};`;
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'disposable-validation-exit',type:'module'}));
  const config={scanRoot:'.',rootDir:'src',validate:{dynamic:{mode:'off'},...(kind==='configured'?{commands:[{label:'exit witness',command:process.execPath,args:['-e',code]}]}:{})}};
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));
  if(kind.startsWith('legacy')){symlinkSync(join(repo,'packages/main/node_modules'),join(root,'node_modules'),'dir');writeFileSync(join(root,'validate.js'),code);}
  const git=a=>execFileSync('git',a,{cwd:root,stdio:'pipe'});git(['init','-q']);git(['config','user.email','lab@example.invalid']);git(['config','user.name','Lab']);git(['add','.']);git(['commit','-qm','Disposable exit fixture']);
  const start=performance.now();const p=spawnSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,'validate',JSON.stringify({json,noSync:true,...(kind==='gate'?{channel:true}:{})})],{cwd:root,encoding:'utf8',timeout:60000});
  const row={name,status:p.status,expected:fails?1:0,seconds:(performance.now()-start)/1000,stdout:p.stdout,stderr:p.stderr,error:p.error?.message};rows.push(row);console.log(JSON.stringify(row));
  assert.equal(p.status,fails?1:0,name+' typed outcome must determine exit, not prose');
 }
 finally{rmSync(root,{recursive:true,force:true});}
}
console.log(`VALIDATION_EXIT_MATRIX_GREEN ${rows.length}`);
