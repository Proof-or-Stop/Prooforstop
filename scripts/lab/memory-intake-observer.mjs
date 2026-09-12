import {registerHooks} from 'node:module';
import {writeFileSync} from 'node:fs';
const stats=globalThis.__memoryIntake={packs:0,cacheLookups:0,cacheHits:0,indexRebuilds:0,indexRebuildMs:0,indexedQueries:0,fullQueries:0,fallbacks:0,fallbackSites:{},fallbackMs:0,fallbackItems:0,loaded:[]};
function replaceOnce(source,needle,replacement){if(!source.includes(needle))throw new Error('MEMORY_OBSERVER_SOURCE_DRIFT '+needle);return source.replace(needle,replacement);}
registerHooks({load(url,ctx,next){const r=next(url,ctx);if(!url.endsWith('/core/playbook-runtime-memory.js')&&!url.endsWith('/core/playbook-runtime-memory-index.js'))return r;let s=String(r.source);stats.loaded.push(url);
 if(url.endsWith('/playbook-runtime-memory.js')){
 s=replaceOnce(s,'function buildMemoryFreshnessPackInternal(options) {','function buildMemoryFreshnessPackInternal(options) { globalThis.__memoryIntake.packs++;');
 s=replaceOnce(s,'const cached = getRuntimeMemoryPackCacheHit(cacheContext);','globalThis.__memoryIntake.cacheLookups++; const cached = getRuntimeMemoryPackCacheHit(cacheContext);');
 s=replaceOnce(s,'if (cached.hit) {','if (cached.hit) { globalThis.__memoryIntake.cacheHits++;');
 s=replaceOnce(s,'return buildRuntimeMemoryIndex(options.projectRoot);','globalThis.__memoryIntake.indexRebuilds++; const intakeStart=performance.now(); try {return buildRuntimeMemoryIndex(options.projectRoot);} finally {globalThis.__memoryIntake.indexRebuildMs+=performance.now()-intakeStart;}');
 const q='const indexed = resolveIndexedCandidates(indexedOptions, query, maxEntries, maxPlaybooks, runtimeIndex);';s=replaceOnce(s,q,q+' globalThis.__memoryIntake[indexed ? "indexedQueries" : "fullQueries"]++;');
 }else{
 s=replaceOnce(s,'function scanSourceMatchingIdsForToken(sourceItems, textForItem, token) {','function scanSourceMatchingIdsForToken(sourceItems, textForItem, token) { const t=performance.now(); globalThis.__memoryIntake.fallbackItems+=sourceItems.length; try {return measuredScanSourceMatchingIdsForToken(sourceItems,textForItem,token);} finally {globalThis.__memoryIntake.fallbackMs+=performance.now()-t;} } function measuredScanSourceMatchingIdsForToken(sourceItems, textForItem, token) {');
 let i=0;s=s.replaceAll('stats.tokenScanFallbacks += 1;',()=>{i++;return 'stats.tokenScanFallbacks += 1; globalThis.__memoryIntake.fallbacks++; globalThis.__memoryIntake.fallbackSites['+i+']=(globalThis.__memoryIntake.fallbackSites['+i+']??0)+1;';});if(i!==4)throw new Error('MEMORY_OBSERVER_FALLBACK_SITES_DRIFT '+i);
 }
 return {...r,source:s};}});
process.on('exit',()=>{if(!process.env.MEMORY_INTAKE_OUTPUT)throw new Error('MEMORY_INTAKE_OUTPUT required');writeFileSync(process.env.MEMORY_INTAKE_OUTPUT,JSON.stringify(stats,null,2));});
