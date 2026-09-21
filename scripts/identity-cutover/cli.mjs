import './bootstrap.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './certification.mjs';
import { repoRoot, trackedFiles } from './repository.mjs';
import { verifyOrdering } from './ordering.mjs';
import { verifyCurrentGuidance, verifyCurrentLegacyContextManifest } from './guidance.mjs';
import { verifyImportedHistoryContexts, verifyIntegrationRootHistoryContext } from './source-integrity.mjs';
import { schemaRows } from './schema-scan.mjs';
import { verifySchemaInventory } from './source-integrity.mjs';
import { scanActiveResidue } from './active-scan.mjs';
const CAPABILITIES = [
 {id:'ordering', modules:['ordering'], checks:['verifyOrdering'], run:(root,files)=>verifyOrdering(root)},
 {id:'current-guidance', modules:['guidance'], checks:['verifyCurrentGuidance','verifyCurrentLegacyContextManifest'], run:(root,files)=>[...verifyCurrentGuidance(root),...verifyCurrentLegacyContextManifest(root)]},
 {id:'history-contexts', modules:['source-integrity'], checks:['verifyImportedHistoryContexts','verifyIntegrationRootHistoryContext'], run:(root,files)=>[...verifyImportedHistoryContexts(root),...verifyIntegrationRootHistoryContext(root)]},
 {id:'schema-inventory', modules:['schema-scan','source-integrity'], checks:['schemaRows','verifySchemaInventory'], run:(root,files)=>verifySchemaInventory(root,schemaRows(root,files))},
 {id:'active-residue', modules:['active-scan'], checks:['scanActiveResidue'], run:(root,files)=>scanActiveResidue(root,files).map(hit=>JSON.stringify(hit))},
];
export function runIdentityCliIfMain(entryUrl,args) {
 if(!process.argv[1]||resolve(process.argv[1])!==fileURLToPath(entryUrl))return;
 if(args.length===1&&args[0]==='--list-capabilities'){console.log(JSON.stringify(CAPABILITIES.map(({run,...row})=>({...row,completeSuite:false}))));return;}
 if(!args.length||args.length===1&&['--all','--boundary-only','--self-test','--print-experiment-baseline','--print-schema-baseline','--print-residue'].includes(args[0])){
   main(args[0]==='--all'?[]:args);return;
 }
 const selected=[...new Set(args.map(arg=>arg.startsWith('--capability=')?arg.slice(13):''))];
 if(!selected.length||selected.some(id=>!CAPABILITIES.some(row=>row.id===id)))throw new Error('Unknown identity verification argument: '+JSON.stringify(args));
 const root=repoRoot(),files=trackedFiles(root),errors=[];
 for(const capability of CAPABILITIES)if(selected.includes(capability.id))errors.push(...capability.run(root,files).map(error=>capability.id+': '+error));
 if(errors.length){for(const error of errors)console.error('IDENTITY_CAPABILITY_FAIL '+error);process.exitCode=1;return;}
 console.log('IDENTITY_PARTIAL_PASS '+JSON.stringify({full:false,capabilities:selected}));
}
