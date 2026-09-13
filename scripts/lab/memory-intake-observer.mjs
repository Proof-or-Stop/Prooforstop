import {registerHooks} from 'node:module';
import {writeFileSync} from 'node:fs';
const output=process.env.MEMORY_INTAKE_OUTPUT;
if(!output)throw new Error('MEMORY_INTAKE_OUTPUT required');
const stats=globalThis.__memoryIntake={packs:0,cacheLookups:0,cacheHits:0,indexRebuilds:0,indexRebuildMs:0,indexedQueries:0,fullQueries:0,fallbacks:0,fallbackSites:{},fallbackMs:0,fallbackItems:0,loaded:[]};
function replaceOnce(source,needle,replacement){const count=source.split(needle).length-1;if(count!==1)throw new Error((count===0?'MEMORY_OBSERVER_SOURCE_DRIFT ':'MEMORY_OBSERVER_SOURCE_AMBIGUOUS ')+needle);return source.replace(needle,replacement);}
registerHooks({load(url,ctx,next){const r=next(url,ctx);if(!url.endsWith('/core/playbook-runtime-memory.js')&&!url.endsWith('/core/playbook-runtime-memory-index.js'))return r;let s=typeof r.source==='string'?r.source:new TextDecoder().decode(r.source);stats.loaded.push(url);
 if(url.endsWith('/playbook-runtime-memory.js')){
 s=replaceOnce(s,'function buildMemoryFreshnessPackInternal(options, inheritLearningScope = false) {','function buildMemoryFreshnessPackInternal(options, inheritLearningScope = false) { globalThis.__memoryIntake.packs++;');
 s=replaceOnce(s,'const early = getRuntimeMemoryPackCacheHit(earlyContext, true);','globalThis.__memoryIntake.cacheLookups++; const early = getRuntimeMemoryPackCacheHit(earlyContext, true);');
 s=replaceOnce(s,'if (early.hit)\n            return', 'if (early.hit) globalThis.__memoryIntake.cacheHits++;\n        if (early.hit)\n            return');
 s=replaceOnce(s,'const cached = getRuntimeMemoryPackCacheHit(cacheContext);','globalThis.__memoryIntake.cacheLookups++; const cached = getRuntimeMemoryPackCacheHit(cacheContext);');
 s=replaceOnce(s,'if (cached.hit) {','if (cached.hit) { globalThis.__memoryIntake.cacheHits++;');
 s=replaceOnce(s,'return buildRuntimeMemoryIndex(options.projectRoot);','globalThis.__memoryIntake.indexRebuilds++; const intakeStart=performance.now(); try {return buildRuntimeMemoryIndex(options.projectRoot);} finally {globalThis.__memoryIntake.indexRebuildMs+=performance.now()-intakeStart;}');
 const q='const indexed = resolveIndexedCandidates(indexedOptions, query, maxEntries, maxPlaybooks, runtimeIndex, cacheContext);';s=replaceOnce(s,q,q+' globalThis.__memoryIntake[indexed ? "indexedQueries" : "fullQueries"]++;');
 }else{
 s=replaceOnce(s,'function scanSourceMatchingIdsForToken(sourceItems, textForItem, token) {','function scanSourceMatchingIdsForToken(sourceItems, textForItem, token) { const t=performance.now(); globalThis.__memoryIntake.fallbackItems+=sourceItems.length; try {return measuredScanSourceMatchingIdsForToken(sourceItems,textForItem,token);} finally {globalThis.__memoryIntake.fallbackMs+=performance.now()-t;} } function measuredScanSourceMatchingIdsForToken(sourceItems, textForItem, token) {');
 const sites=[
  'stats.exactOverflowFallbacks += uniqueInOrder(overflowedIndexedTokens).length;\n    stats.tokenScanFallbacks += 1;',
  'if (overflowExactTokens.has(token)) {\n            stats.exactOverflowFallbacks += 1;\n            stats.tokenScanFallbacks += 1;',
  'if (containingTokens.fallback) {\n            stats.fuzzyFallbacks += 1;\n            stats.tokenScanFallbacks += 1;',
  'if (containedTokens.overflow) {\n            stats.fuzzyFallbacks += 1;\n            stats.tokenScanFallbacks += 1;',
 ];
 if(s.split('stats.tokenScanFallbacks += 1;').length-1!==sites.length)throw new Error('MEMORY_OBSERVER_FALLBACK_SITES_DRIFT');
 sites.forEach((needle,index)=>{const site=index+1;s=replaceOnce(s,needle,needle+' globalThis.__memoryIntake.fallbacks++; globalThis.__memoryIntake.fallbackSites['+site+']=(globalThis.__memoryIntake.fallbackSites['+site+']??0)+1;');});
 }
 return {...r,source:s};}});
process.on('exit',()=>{writeFileSync(output,JSON.stringify(stats,null,2));});
