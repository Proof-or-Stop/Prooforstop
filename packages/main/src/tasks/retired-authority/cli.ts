import assert from 'node:assert/strict';
import { runRetiredComplete } from './driver.js';
import { assertPositiveControls, assertImportSpecifierPositiveControls, assertHermeticTraversalPositiveControls, assertShippedExecutableRootPositiveControls, assertNormalizedSpecifierPositiveControls } from "./positive-controls.js";
import { assertDynamicCodeGenerationPositiveControls } from "./execution-controls.js";
import { assertLoaderArgumentProvenance } from "./loader-controls.js";
import { assertLegacyDeliveryCompatibilityPositiveControls } from "./compatibility-controls.js";
import { assertContract, assertCommandCatalog, assertGeneratedHelp } from "./public-contract.js";
const CAPABILITIES = [
 { id: 'vocabulary-controls', checks: ["assertPositiveControls"], run: () => { assertPositiveControls(); } },
 { id: 'import-controls', checks: ["assertImportSpecifierPositiveControls","assertHermeticTraversalPositiveControls","assertShippedExecutableRootPositiveControls","assertNormalizedSpecifierPositiveControls"], run: () => { assertImportSpecifierPositiveControls(); assertHermeticTraversalPositiveControls(); assertShippedExecutableRootPositiveControls(); assertNormalizedSpecifierPositiveControls(); } },
 { id: 'dynamic-controls', checks: ["assertDynamicCodeGenerationPositiveControls"], run: () => { assertDynamicCodeGenerationPositiveControls(); } },
 { id: 'loader-provenance', checks: ["assertLoaderArgumentProvenance"], run: () => { assertLoaderArgumentProvenance(); } },
 { id: 'compatibility-controls', checks: ["assertLegacyDeliveryCompatibilityPositiveControls"], run: () => { assertLegacyDeliveryCompatibilityPositiveControls(); } },
 { id: 'public-contract', checks: ["assertContract","assertCommandCatalog","assertGeneratedHelp"], run: () => { assertContract(); assert.deepEqual(assertCommandCatalog(), []); assert.deepEqual(assertGeneratedHelp(), []); } },
];
export function runRetiredCli(args: string[]): void {
 if(args.length===1&&args[0]==='--list-capabilities'){console.log(JSON.stringify(CAPABILITIES.map(({id,checks})=>({id,checks,completeSuite:false}))));return;}
 if(!args.length||args.length===1&&['--all','--lab-graph-loader-proof'].includes(args[0])){runRetiredComplete();return;}
 const selected=[...new Set(args.map(arg=>{if(!arg.startsWith('--capability=')||!CAPABILITIES.some(row=>row.id===arg.slice(13)))throw new Error('Unknown retired vocabulary verification argument: '+arg);return arg.slice(13);}))];
 for(const row of CAPABILITIES)if(selected.includes(row.id))row.run();
 console.log('RETIRED_VOCABULARY_PARTIAL_PASS '+JSON.stringify({full:false,capabilities:selected}));
}
