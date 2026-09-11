import {createHash} from 'node:crypto';
export const PACK='scripts/verify-proof-or-stop-pack-boundary.mjs';
export const NEUTRAL='scripts/helpers/provider-neutral-fixture.mjs';
const QUORUM='packages/main/dist/tasks/quorum-submit-smoke.js';
const WRAPPER='scripts/run-validation-fixture-suite.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function extraMode({ts,file,text,ast,entry,argv,contract}){
 if(contract.routes?.[file]){
   const row=contract.routes[file],errors=hash(text)===row.sourceDigest?[]:['Reviewed nested witness source changed'],edges=[];
   return {errors,edges,shouldSkip:()=>false,requireKnownChild:false,knownNonNode:new Set(),launchFor(node){if(hash(node.getText(ast))!==row.callDigest)return null;edges.push(...row.targets);return row;}};
 }
 if(file==='scripts/verify-global-lab-entrypoint.mjs'){
  const errors=hash(text)===contract.globalLabDigest&&JSON.stringify(argv)===JSON.stringify(['lab-help'])?[]:['Unreviewed global Lab mode/source'];
  return {errors,edges:[],requireKnownChild:false,knownNonNode:new Set(),launchFor:()=>null,shouldSkip(node){
   if(errors.length)return false;
   if(ts.isFunctionDeclaration(node)&&ts.isSourceFile(node.parent))return !['run','assert'].includes(node.name?.text);
   if(ts.isPropertyAssignment(node)&&ts.isObjectLiteralExpression(node.parent)&&node.parent.parent?.name?.getText(ast)==='checks')return node.name.text!=='lab-help';
   return false;
  }};
 }
 if(file===WRAPPER)return {errors:hash(text)===contract.wrapperDigest?[]:['Reviewed fixture wrapper changed'],edges:[],shouldSkip:()=>false,launchFor:()=>null,requireKnownChild:false,knownNonNode:new Set()};
 if(![PACK,NEUTRAL].includes(file))return null;
 const errors=[],edges=[];
 if(hash(text)!==contract.extra[file].sourceDigest)errors.push('Reviewed child mode source changed: '+file);
 const functions=new Map();for(const n of ast.statements)if(ts.isFunctionDeclaration(n)&&n.name)functions.set(n.name.text,n);
 const active=new Set();let mode;
 if(file===PACK){
  const imported=entry==='packages/main/tests/canonical-new-story-artifacts.test.mjs' && (argv.length===0 || JSON.stringify(argv)===JSON.stringify(['--group=runtime']));
  if(!imported && JSON.stringify(argv)!==JSON.stringify(['--quiet']))errors.push('Unreviewed packed-boundary invocation');
  if(imported){active.add('prepareOfflineDependencyOverrides');active.add('sourceManifests');}else active.add('runBoundary');
  function refs(n){if(ts.isIdentifier(n)&&functions.has(n.text))active.add(n.text);ts.forEachChild(n,refs);}
  for(let before=-1;before!==active.size;){before=active.size;for(const name of [...active])ts.forEachChild(functions.get(name),refs);}
 }else{
  if(entry===WRAPPER){mode=argv[0]===QUORUM?'call':'inactive';if(mode==='call'&&JSON.stringify(argv.slice(1))!==JSON.stringify(['--jobs=2']))errors.push('Unreviewed quorum wrapper argv');}
  else if(entry===NEUTRAL&&argv.length===4&&['--bootstrap','--worker'].includes(argv[0])&&argv[1]==='<owned-mkdtemp-root>'&&argv[2]===QUORUM&&argv[3]==='--jobs=2')mode=argv[0];
  else{mode='invalid';errors.push('Unreviewed provider-neutral invocation');}
  const names=mode==='call'?['runProviderNeutralFixture','inspectFixtureProcess','sameIdentity','groupMembers','waitOwnedExit','terminateOwnedFixture']:mode==='--bootstrap'?['inspectFixtureProcess']:[];
  for(const name of names)active.add(name);
 }
 const shouldSkip=node=>{
  if(errors.length)return false;
  if(ts.isFunctionDeclaration(node)&&functions.get(node.name?.text)===node&&!active.has(node.name.text))return true;
  if(file===PACK&&ts.isIfStatement(node)&&node.expression.getText(ast)==='invokedDirectly && cacheWorkerArg')return true;
  if(file===NEUTRAL){
   for(let p=node.parent;p;p=p.parent){
    if(ts.isIfStatement(p)&&p.expression.getText(ast).includes("mode === '--bootstrap'")){
      if(node===p.thenStatement&&mode!=='--bootstrap')return true;
      // else-if worker remains visible only to --worker; no recursion from bootstrap.
      if(node===p.elseStatement&&mode!=='--worker')return true;
    }
   }
  }
  return false;
 };
 return {errors,edges,shouldSkip,requireKnownChild:file===NEUTRAL,knownNonNode:new Set(contract.extra[file].nonNodeCalls),launchFor(node){
  const row=contract.extra[file].launches.find(r=>r.callDigest===hash(node.getText(ast)));if(!row)return null;
  if(file===NEUTRAL){for(const target of row.targets)edges.push({...target,argumentBindings:{'<owned-mkdtemp-root>':'unique realpath(mkdtempSync(tmpdir)); same signed-owner launch directory, never caller input'}});}
  return row;
 }};
}
