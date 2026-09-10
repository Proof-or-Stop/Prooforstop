import {materialInventory} from './inventory.mjs';
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{execFileSync}from'node:child_process';import{resolve,join,basename}from'node:path';import{pathToFileURL,fileURLToPath}from'node:url';
const repo=resolve(process.argv[2]||process.cwd()),out=resolve(process.argv[3]||fileURLToPath(new URL('.',import.meta.url)));mkdirSync(out,{recursive:true});
const load=p=>import(pathToFileURL(join(repo,'packages/main/dist/core/'+p+'.js')));const{isMaterialExcludedPath}=await load('material-path-policy');const{buildValidationCommandInventory}=await load('validation-command-identity');const{configuredValidationCommandEntries}=await load('validation-command-config');
const prior=JSON.parse(readFileSync(new URL('./functional-seed.json',import.meta.url)));const config=JSON.parse(readFileSync(join(repo,'proof-or-stop.config.json')));const{commands}=configuredValidationCommandEntries(config);const inventory=buildValidationCommandInventory({commands});
const paths=materialInventory(repo,isMaterialExcludedPath);const present=new Set(paths),owners=new Map(),basis=new Map();
function assign(p,ids,why){owners.set(p,ids);basis.set(p,why)}
for(const domain of prior.responsibilities)for(const p of domain.paths)if(present.has(p))assign(p,[...new Set([...(owners.get(p)||[]),domain.id])],'prior reviewed functional seed');
const archivePrefixes=['.remember/logs/','.lattice/runtime/'];
// Name matches prepare explicit governance proposals; they are NOT semantic proof.
// No imports, registry propagation, or layer-wide fallback is used.
const capabilities=[
 ['scope-acceptance',/(?:scope-budget|scope-contract|scope-decomposition|scope-shrink|scope-question|scope-check|acceptance-amendment|acceptance-topology|acceptance-rollout|proofstory|pre-review|intent-collision|parallel-decomposition|semantic-scope|scope-path)/],
 ['provider-execution',/(?:managed-host|managed-review|host-run|host-execution|provider-process|provider-admission|supervised-process|supervisor|planned-steps-executor|review-host|cross-provider|host-adapter|host-availability|native-review-binding)/],
 ['review-authority',/(?:review-inventory|review-run|review-pass|reviewer|review-quorum|quorum-submit|review-authority|review-convergence|finding|severity|remediation|adversarial-review)/],
 ['validation-certification',/(?:validation|validate|certification|precert|pre-cert|full-suite|causal-preflight|selector-contract|machine-port|execution-lock|cross-scheduler|keyed-scheduler|final-validation|dynamic-command|command-observation|clean-tree)/],
 ['lifecycle-ownership',/(?:lifecycle|story-owner|session-ownership|session-brief|owner-lease|phase-flow|story-advance|transition-orchestrator|done-|done\.|closeout|convergence-breaker)/],
 ['runtime-memory',/(?:memory|playbook|experience|learning|lesson|remember|retro|knowledge|context-pack|recall|runtime-consumption)/],
 ['evidence-storage',/(?:evidence|artifact|authority-signing|material-hash|material-tree|story-hash|story-git|git-probe|git-root|git-cwd|receipt|causal-tool)/],
 ['managed-assets',/(?:agent-prompt|agents-init|agent-registry|role-registry|prompt-envelope|prompt-package|bootstrap|brand-|brand\.|install|template|codex-adapter|claude-adapter|agy-adapter|managed-asset)/],
 ['lab-build-maintenance',/(?:lab-|build-|build\.|source-dist|version|release|publish|package-lock|package\.json)/],
 ['dependency-graph-package',/(?:dependency-graph|graph-query|graph-audit|graph-cache)/],
];
const sharedNames=new Set(['config.ts','store.ts','types.ts','errors.ts','utils.ts','path-utils.ts','json-utils.ts','hash.ts','git.ts','fs-utils.ts','atomic-write.ts','file-lock.ts','lock.ts','process-fact-registry.ts','runtime-fact-registry.ts','command-policy.ts','tools.ts','index.ts']);
const packageDomains=[['packages/graph/','dependency-graph-package'],['packages/lab/','optimization-lab-package'],['packages/utils/','extension-utilities-package']];
for(const p of paths){if(archivePrefixes.some(x=>p.startsWith(x))){assign(p,['historical-archive'],'explicit bounded historical log subtree');continue}if(owners.has(p))continue;
 const pkg=packageDomains.find(([prefix])=>p.startsWith(prefix));if(pkg){assign(p,[pkg[1]],'explicit package capability boundary');continue}
 if(p.startsWith('packages/main/src/core/')&&sharedNames.has(basename(p))){assign(p,['shared-core-utilities'],'explicit shared utility, no owner propagation');continue}
 // Current executable code, dedicated scripts, fixtures and documentation only.
 if(!/^(packages\/main\/(src|tests)\/|scripts\/|docs\/|\.claude\/|\.proof-or-stop-codex\/|bin\/)/.test(p))continue;
 const name=basename(p).toLowerCase();const hits=capabilities.filter(([,re])=>re.test(name));
 if(hits.length===1)assign(p,[hits[0][0]],'single capability-name proposal requiring content review');
 // Ambiguous names remain explicit review items rather than accumulating owners.
}
const commandRows=[];const groupIds=new Map();for(const entry of inventory.entries){let refs=[],domains=[],why;
 const args=entry.tuple.args||[];
 if(entry.tuple.command==='npm'&&args.join(' ')==='--prefix packages/main run build'){domains=['lab-build-maintenance'];why='root-reviewed npm expansion: node ../../scripts/build-main-with-binding.mjs'}
 else if(entry.tuple.command==='npm'&&args.join(' ')==='--prefix packages/graph run check'){domains=['dependency-graph-package'];why='root-reviewed graph npm check chain'}
 else{for(const arg of args){if(typeof arg!=='string')continue;const p=arg.replace(/^\.\//,'');const source=p.replace('/dist/','/src/').replace(/\.js$/,'.ts');if(present.has(source))refs.push(source);else if(present.has(p))refs.push(p)}domains=[...new Set(refs.flatMap(p=>owners.get(p)||[]))];why='direct configured entrypoint ownership; no import propagation'}
 for(const d of domains){if(!groupIds.has(d))groupIds.set(d,[]);groupIds.get(d).push(entry.id)}commandRows.push({id:entry.id,label:entry.label,tuple:entry.tuple,sourceRefs:refs,domains,basis:why});}
const domainIds=[...new Set([...owners.values()].flat())].sort();const policy={...prior,responsibilities:domainIds.map(id=>({id,paths:id==='historical-archive'?archivePrefixes.map(p=>p+'**'):paths.filter(p=>owners.get(p)?.includes(id)).sort(),hostAdapters:prior.responsibilities.find(r=>r.id===id)?.hostAdapters||[],validationGroups:groupIds.has(id)?[id+'-checks']:[]})),validationGroups:[...groupIds].map(([id,ids])=>({id:id+'-checks',commandIds:[...new Set(ids)].sort()}))};
const unresolved=paths.filter(p=>!owners.has(p));const codeUnresolved=unresolved.filter(p=>/^(packages\/|scripts\/|bin\/)/.test(p));
const report={head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),materialPaths:paths.length,assigned:owners.size,archivePaths:paths.filter(p=>owners.get(p)?.includes('historical-archive')).length,unresolved:unresolved.length,unresolvedCode:codeUnresolved.length,canonicalCommands:commandRows.length,unresolvedCommands:commandRows.filter(c=>!c.domains.length),warning:'Incomplete explicit governance proposal; cannot enable globally until unresolved current-source and command ownership is reviewed.'};
writeFileSync(join(out,'policy.json'),JSON.stringify(policy,null,2));writeFileSync(join(out,'evidence.json'),JSON.stringify({summary:report,assignments:[...owners].filter(([p])=>!archivePrefixes.some(a=>p.startsWith(a))).map(([path,domains])=>({path,domains,basis:basis.get(path)})),commands:commandRows},null,2));writeFileSync(join(out,'unresolved-code.json'),JSON.stringify(codeUnresolved,null,2));writeFileSync(join(out,'unresolved-all.json'),JSON.stringify(unresolved,null,2));console.log(JSON.stringify(report,null,2));
