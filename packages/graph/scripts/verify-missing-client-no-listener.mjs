import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {StoryStore} from '../../main/dist/core/store.js';
const lab=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
assert.ok(existsSync(join(lab,'packages/graph/assets/app.html')),'PRECONDITION_FAILED: build graph client first');
const root=mkdtempSync(join(tmpdir(),'graph-no-assets-'));
try {
 mkdirSync(join(root,'packages'),{recursive:true});cpSync(join(lab,'packages/graph'),join(root,'packages/graph'),{recursive:true});
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 const store=new StoryStore(root);store.writeStory('B-negative',{storyId:'B-negative',name:'Missing graph client control',title:'Must fail before listening',description:'Private test fixture',type:'chore',phase:'DEV',priority:'medium',createdAt:new Date().toISOString()});store.writeChecklist('B-negative',{items:[]});
 execFileSync('git',['init','-q'],{cwd:root});
 const pkg=join(root,'packages/graph');rmSync(join(pkg,'assets/app.html'));
 const manifest=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'));manifest.scripts.build='node -e "process.exit(0)"';writeFileSync(join(pkg,'package.json'),JSON.stringify(manifest));
 const observer=join(root,'listen-observer.mjs'),listenLog=join(root,'listens.jsonl');
 writeFileSync(observer,`import net from 'node:net';import fs from 'node:fs';const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){fs.appendFileSync(${JSON.stringify(listenLog)},JSON.stringify({pid:process.pid})+'\\n');return Reflect.apply(original,this,args);};`);
 const result=spawnSync(process.execPath,[join(lab,'bin/proof-or-stop.js'),'graph','--no-open','--port=0','--root='+root],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS??'','--import='+JSON.stringify(pathToFileURL(observer).href)].join(' ')}});
 assert.notEqual(result.status,0,'A successful build without required assets must refuse');assert.equal(result.signal,null,'Failure must exit normally, not reach timeout');
 const output=result.stdout+result.stderr;assert.match(output,/required output is missing/);assert.match(output,/app\.html/);assert.match(output,/npm --prefix .*packages\/graph run build/);
 assert.ok(!existsSync(listenLog),'Must reject before any net.Server.listen call');
 console.log('GRAPH_MISSING_ASSETS_REFUSED_BEFORE_LISTEN');
} finally {rmSync(root,{recursive:true,force:true});const cache=join(homedir(),'.cache/proof-or-stop-graph',basename(root)+'-'+createHash('sha256').update(root).digest('hex').slice(0,12));rmSync(cache,{recursive:true,force:true});}
