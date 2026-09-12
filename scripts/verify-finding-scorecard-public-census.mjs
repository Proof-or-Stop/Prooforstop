import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks,createRequire} from 'node:module';
const repositoryRoot=process.cwd();
const require=createRequire(join(repositoryRoot,'package.json'));
const ts=require('typescript');
registerHooks({resolve(specifier,context,next){
  if(context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')){
    const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(url))return next(url.href,context);
  }return next(specifier,context);
},load(url,context,next){if(!url.endsWith('.ts'))return next(url,context);
  return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
}});
const source=path=>import('file://'+join(repositoryRoot,'packages/main/src',path));
const {StoryStore}=await source('core/store.ts');
const ledgerApi=await source('handlers/finding-ledger.ts');
const {canonicalHash}=await source('core/finding-ledger.ts');
const {signCanonical}=await source('core/authority-signing.ts');
const {withMkdirLock,captureMkdirLockFence}=await source('core/mkdir-lock.ts');
const {applicabilityDigest}=await source('core/finding-applicability.ts');
const {FINDING_QUALIFICATION_POLICY,buildFindingQualificationScorecard}=await source('core/finding-rollout-qualification.ts');
const {sumQualificationCohortTiming}=await source('handlers/finding-qualification-events.ts');
const root=mkdtempSync(join(tmpdir(),'scorecard-public-census-'));
const storyId='B-CENSUS';
try {
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'src',storyDir:'.proof-or-stop/story/actives'}));
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'census',title:'Census fixture',description:'Disposable native signed census fixture',type:'feature',priority:'low',phase:'DONE',createdAt:new Date().toISOString(),startedAt:null,endedAt:null,events:[]});
  const ctx={root,store,scanRoot:join(root,'src')};
  const signer=ledgerApi.findingLedgerSignerFromWorkspace(root);
  const foreignRoot=join(root,'foreign');mkdirSync(foreignRoot);
  writeFileSync(join(foreignRoot,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'src'}));
  const foreignSigner=ledgerApi.findingLedgerSignerFromWorkspace(foreignRoot);
  const lock=store.runtimeLockDirPath(storyId,'finding','findings');
  withMkdirLock(lock,()=>{const fence=captureMkdirLockFence(lock);ledgerApi.appendFindingLedger({storyId,store,operation:'append_candidate_route',idempotencyKey:'census-fixture',records:[{recordType:'candidate_route',payload:{fixture:'census-one'}},{recordType:'candidate_route',payload:{fixture:'census-two'}}],writerSessionId:'fixture',writerLeaseId:'fixture',writerFenceToken:fence.writerFenceToken,fence,signer});},{requireHolderToken:true});
  const actualQuery=()=>ledgerApi.createFindingLedgerHandlers(ctx).finding_ledger_query({storyId});
  const baseline=actualQuery();
  assert.equal(baseline.rows.length,5);
  assert.ok(baseline.rows.every(row=>ledgerApi.verifyFindingLedgerQueryRow(row,ledgerApi.findingLedgerTrustFromWorkspace(root))));
  const census=baseline.rows.find(row=>row.category==='migration').details.records;
  assert.equal(census.length,2);
  const refs=census.map(row=>({storyId,recordId:row.recordId,recordHash:row.recordHash}));
  const ref=refs[0];
  console.log('SCORECARD_CENSUS_SETUP PASS actual public handler signed five-row query and native ledger carrier');

  // Execute unchanged production reducer code. Only historical case admission is
  // supplied as an already-admitted diagnostic case; its independent-review
  // lifecycle is outside this boundary test. Public query and crypto are real.
  const handlerPath=join(repositoryRoot,'packages/main/src/handlers/finding-qualification.ts');
  const compiled=ts.transpileModule(readFileSync(handlerPath,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const ast=ts.createSourceFile('handler.js',compiled,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  let program=compiled;
  for(const node of [...ast.statements].reverse())if(ts.isImportDeclaration(node))program=program.slice(0,node.getStart(ast))+program.slice(node.end);
  program=program.replaceAll('export ','');
  const caseStart=program.indexOf('function findingQualificationQuery(');
  const caseNode=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='findingQualificationQuery');
  assert.ok(caseNode&&caseStart>=0,'exact existing historical admission seam');
  // Rename only the admission declaration, leaving the real reducer call bound
  // to the supplied admitted-case dependency below.
  program=program.replace('function findingQualificationQuery(', 'function unusedHistoricalCaseAdmission(');
  let protectedReads=0,publicReads=0;
  const guardedStore=new Proxy(store,{get(target,key){if(key==='readFindingLedger')return ()=>{protectedReads++;throw Error('PROTECTED_SCORECARD_STORE_READ');};return Reflect.get(target,key);}});
  let mutation=query=>query,covered=true;
  const caseRecord={policyDigest:applicabilityDigest(FINDING_QUALIFICATION_POLICY),observedAt:'2026-09-11T00:00:00.000Z',materialHash:'diagnostic-old-material',featureState:'observe',repositoryHead:'fixture-head',storyClass:'fixture',detectorVersion:'fixture',retryPolicy:'none',exclusions:[],latencyHardware:'fixture',simpleStoryRegression:null,timeoutRate:null,latencyCorpusSize:0,candidateBaselineExplained:false,prerequisites:{},queryMeasurements:[],publicQueries:{ledger:{storyId},experiments:{performanceMetadata:null}}};
  const dependencies={loadConfig:()=>({dynamicFinding:{qualificationStoryIds:[storyId]}}),
    historicalStoryContext:()=>({...ctx,store:guardedStore}),
    findingQualificationQuery:()=>[{payload:{...caseRecord,subjectAdjudications:covered?refs.map(ref=>({ref})):[]}}],
    createFindingLedgerHandlers:()=>({finding_ledger_query:()=>{publicReads++;return mutation(actualQuery());}}),
    findingLedgerTrustFromWorkspace:ledgerApi.findingLedgerTrustFromWorkspace,
    currentFindingLedgerTrustFromWorkspace:ledgerApi.findingLedgerTrustFromWorkspace,
    verifyFindingLedgerQueryRow:ledgerApi.verifyFindingLedgerQueryRow,canonicalHash,applicabilityDigest,
    FINDING_QUALIFICATION_POLICY,buildFindingQualificationScorecard,sumQualificationCohortTiming,
    currentMaterialHash:()=> 'current-material',collectQualificationPrerequisites:()=>{throw Error('diagnostic prerequisites unavailable');}};
  const aggregate=new Function(...Object.keys(dependencies),program+'\nreturn readFindingQualificationScorecard;')(...Object.values(dependencies));
  const result=aggregate(ctx);
  console.log('SCORECARD_CENSUS_OBSERVED '+JSON.stringify({protectedReads,publicReads,refusalReasons:result.refusalReasons}));
  assert.equal(protectedReads,0,'SCORECARD_PUBLIC_CENSUS_BOUNDARY: reducer must consume public census without direct protected-store reads');
  assert.equal(publicReads,1);
  assert.equal(result.refusalReasons.some(x=>x.startsWith('unadjudicated_corpus_subject:')),false);
  covered=false;
  assert.ok(aggregate(ctx).refusalReasons.includes('unadjudicated_corpus_subject:'+storyId+':'+ref.recordId));
  covered=true;
  function resign(row, key=signer){const {rowDigest,signature,...rest}=row;const {keyId,algorithm,trustRootDigest,keyFreshnessPolicyDigest,...core}=rest;const signed={...core,rowDigest:canonicalHash(core),keyId:key.keyId,algorithm,trustRootDigest:key.trustRootDigest,keyFreshnessPolicyDigest:key.keyFreshnessPolicyDigest};return {...signed,signature:signCanonical(signed,key.privateKey)};}
  let checks=0;
  for(const [name,change] of [
    ['missing census',q=>{q.rows=q.rows.filter(r=>r.category!=='migration');}],
    ['duplicate census',q=>{q.rows.push(q.rows.find(r=>r.category==='migration'));}],
    ['wrong Story',q=>{q.storyId='B-OTHER';}],
    ['tampered census',q=>{q.rows.find(r=>r.category==='migration').details.records[0].recordHash='wrong';}],
    ['missing record',q=>{const i=q.rows.findIndex(r=>r.category==='migration');q.rows[i].details.records=[];q.rows[i]=resign(q.rows[i]);}],
    ['duplicate record',q=>{const i=q.rows.findIndex(r=>r.category==='migration');q.rows[i].details.records[1]=q.rows[i].details.records[0];q.rows[i].evidenceDigests=q.rows[i].details.records.map(r=>r.recordHash).sort();q.rows[i]=resign(q.rows[i]);}],
    ['signed malformed identity',q=>{const i=q.rows.findIndex(r=>r.category==='migration');q.rows[i].details.records[0].recordId='';q.rows[i]=resign(q.rows[i]);}],
    ['count mismatch',q=>{const i=q.rows.findIndex(r=>r.category==='migration');q.rows[i].numerator=0;q.rows[i]=resign(q.rows[i]);}],
    ['signed hash census mismatch',q=>{const i=q.rows.findIndex(r=>r.category==='migration');q.rows[i].evidenceDigests=[];q.rows[i]=resign(q.rows[i]);}],
    ['wrong signed Story',q=>{const i=q.rows.findIndex(r=>r.category==='migration');q.rows[i].storyId='B-OTHER';q.rows[i]=resign(q.rows[i]);}],
    ['caller key substitution',q=>{q.publicKey='caller-controlled';}],
    ['foreign signed census',q=>{q.rows=q.rows.map(r=>resign(r,foreignSigner));q.publicKey=foreignSigner.publicKey;assert.ok(q.rows.every(r=>ledgerApi.verifyFindingLedgerQueryRow(r,ledgerApi.findingLedgerTrustFromWorkspace(foreignRoot))));}],
    ['wrong snapshot',q=>{q.snapshotDigest='wrong';}],
  ]){mutation=q=>{change(q);if(name!=='wrong snapshot')q.snapshotDigest=canonicalHash(q.rows);return q;};const report=aggregate(ctx);assert.ok(report.refusalReasons.some(x=>x.startsWith('qualification: public census')),name);checks++;}
  mutation=q=>q;
  assert.equal(aggregate(ctx).refusalReasons.some(x=>x.startsWith('qualification: public census')),false);
  assert.equal(protectedReads,0);
  console.log('SCORECARD_PUBLIC_CENSUS PASS '+checks+' malformed/tampered census controls, uncovered refusal and restored native public-query positive');
}finally{rmSync(root,{recursive:true,force:true});}
