import {prospective} from './inventory.mjs';
// Prepared for one post-quiet generation. Operates only cached inventory + /tmp.
import{readFileSync,writeFileSync}from'node:fs';import{basename,resolve,join}from'node:path';
import{pathToFileURL}from'node:url';
const output=resolve(process.argv[3]||'.');const artifact=p=>pathToFileURL(join(output,p));
const dynamic=new Set(['policy.json','evidence.json','unresolved-all.json']);
const get=p=>JSON.parse(readFileSync(dynamic.has(p)?artifact(p):new URL(p,import.meta.url)));const policy=get('policy.json'),e=get('evidence.json');const first=get('refinement-rules.json'),more=get('refinement-more.json');
const material=get('final-material-rules.json');
const all=[...new Set([...e.assignments.map(r=>r.path),...get('unresolved-all.json')])];
const assignments=new Map(e.assignments.map(row=>[row.path,row]));
const rules=[...first.rules,...more.additionalFamilies,
 {domain:'usage-accounting',directoryFamilies:['packages/main/src/core/usage-ledger/'],nameFamilies:['usage-'],basis:'root-approved usage accounting capability'},
 {domain:'runtime-observability',nameFamilies:['observability-','process-events','process-metrics','dashboard.'],basis:'root-approved runtime observability capability'},
 {domain:'framework-audit',nameFamilies:['audit-','audit.'],basis:'root-approved advisory framework audit capability'},
 {domain:'scope-acceptance',nameFamilies:['candidate-spec-routing'],basis:'root-approved actual requirements corpus routing contract'},
 {domain:'validation-certification',nameFamilies:['evaluate.'],basis:'root-approved actual browser evaluation contract'},
 {domain:'lifecycle-ownership',nameFamilies:['gap.','gap-analyze','gap-log'],basis:'root-approved lifecycle convergence diagnostics'},
 {domain:'review-authority',nameFamilies:['bug.','bug-report','bug-extract'],basis:'root-approved Story defect processing'},
];
function matches(path,rule){const name=basename(path).toLowerCase();return rule.exactPaths?.includes(path)||rule.exactBasenames?.includes(name)
 ||[...(rule.directoryFamilies||[]),...(rule.pathFamily?[rule.pathFamily]:[])].some(prefix=>path.startsWith(prefix))
 ||(rule.testFamily?(rule.testFamily.includes('[a-d]')?new RegExp('^'+rule.testFamily.replace('[a-d]','[a-d]')).test(path):path.startsWith(rule.testFamily)):false)
 ||(rule.nameFamilies||[]).some(prefix=>name.startsWith(prefix)||name.startsWith('verify-'+prefix)||name.startsWith('red-'+prefix));}
const ambiguous=[];for(const path of all){
 if(path.startsWith('scripts/lab/u17-original/')||path==='scripts/verify-u17-original-evidence.mjs'){assignments.set(path,{path,domains:['evidence-storage'],basis:'Root-approved U17 original-target instrumentation/evidence capability'});continue}
 const prospectiveRow=prospective.files.find(row=>row.path===path);if(prospectiveRow){assignments.set(path,{path,domains:[prospectiveRow.domain],basis:prospective.basis});continue}
 const governance=['.c8rc.json','.gitattributes','.githooks/commit-msg','.githooks/pre-push','.gitignore','CHANGELOG.md','CITATION.cff','LICENSE','README.md','docs/guide.md','lattice.config.json','package-lock.json','package.json','proof-or-stop.config.json'];
 if(governance.includes(path)){assignments.set(path,{path,domains:['project-governance'],basis:'Root-approved exact cross-project contract, not a fallback'});continue}
 if(path==='docs/decode/super-power.md'){assignments.set(path,{path,domains:['runtime-memory'],basis:'Explicit external learning reference note; does not imply runtime consumption'});continue}
 const explicitMaterial=[
  [/^(\.claude\/agents\/|\.proof-or-stop-codex\/agents\/)/,'managed-assets'],
  [/^(\.claude|\.codex)\/hooks\/.*scope-pretool\.cjs$/,'scope-acceptance'],
  [/^\.codex\/hooks\/.*evidence-pretool\.cjs$/,'evidence-storage'],
  [/^\.claude\/hooks\/log-tools\.cjs$/,'runtime-observability'],
  [/^(\.claude\/settings\.json|\.codex\/hooks\.json|\.proof-or-stop-codex\/(README\.md|proof-or-stop\.json)|\.proof-or-stop\/(Proof-or-Stop\.md|proof-or-stop\.json)|AGENTS\.md|CLAUDE\.md|tests\/AGENTS\.verify\.mjs)$/,'managed-assets'],
  [/^docs\/lab-evidence\/u09-/,'validation-certification'],
  [/^docs\/lab-evidence\/u17-/,'evidence-storage'],
  [/^docs\/lab-evidence\/u06-/,'scope-acceptance'],
  [/^(B-.*\.(md|html)|RESUME-B-.*\.md|UNBLOCK-B3F3D-B49ED\.sh|docs\/metadata\/flow\.json|docs\/features\/B-001\.json)$/,'lifecycle-ownership'],
  [/^tests\/(blackbox|fixtures|helpers)\//,'validation-certification'],
  [/^docs\/evidence\//,'evidence-storage'],
  [/^docs\/assets\/fig-gate-ablation\.png$/,'optimization-lab-package'],
  [/^docs\/audits\/inventory-critic-purpose-isolation\.md$/,'review-authority'],
  [/^docs\/dev\/test-coverage\.md$/,'validation-certification'],
  [/^docs\/requirements\/(NAV\.md|decisions\/\.gitkeep|extracted\/\.gitkeep)$/,'scope-acceptance'],
  [/^docs\/requirements\/decisions\/bounded-document-context-scaling/,'managed-assets'],
  [/^docs\/requirements\/decisions\/graph-command-migration/,'dependency-graph-package'],
  [/^proof-or-stop-experience-layer/,'runtime-memory'],
  [/^CODEX-FINDINGS\.md$/,'review-authority'],
  [/^\.proof-or-stop\/artifact-releases\.jsonl$/,'evidence-storage'],
  [/^\.proof-or-stop\/capability-releases\.jsonl$/,'command-surface'],
  [/^\.remember-scratch-readmanifest\.json$/,'review-authority'],
  [/^\.worktrees_verify_out\.txt$/,'lifecycle-ownership']
 ].find(([pattern])=>pattern.test(path));
 if(explicitMaterial){assignments.set(path,{path,domains:[explicitMaterial[1]],basis:'Explicit bounded current material capability, no unknown fallback'});continue}
 const approved=Object.entries(material.rootApprovedSubtrees).find(([prefix])=>path.startsWith(prefix));
 if(approved){assignments.set(path,{path,domains:[approved[1]],basis:'Root-approved legacy metadata/learning capability; not a runtime consumption claim'});continue}
 if(path.startsWith('experiments/')){
  const result=path.startsWith('experiments/multi-model-ablation/future-cell03-results/full/')&&/\.(json|jsonl|log)$/.test(path);
  assignments.set(path,{path,domains:[result?'historical-archive':'optimization-lab-package'],basis:result?'Root-approved bounded result file extension, excludes executable code':'Explicit experiment harness/corpus capability; recovery-runner README read'});continue
 }
 if(path.startsWith('docs/')&&!assignments.has(path)){
  const theme=Object.entries(material.exactDocumentationThemes).filter(([,terms])=>terms.some(t=>basename(path).startsWith(t)));
  if(theme.length===1){assignments.set(path,{path,domains:[theme[0][0]],basis:'Explicit document topic proposal under reviewed capability'});continue}
 }

 if(!/^(packages\/|scripts\/|docs\/|bin\/|\.claude\/|\.proof-or-stop-codex\/)/.test(path))continue;
 const explicit=rules.find(r=>r.exactPaths?.includes(path));if(explicit){assignments.set(path,{path,domains:explicit.domains||[explicit.domain],basis:explicit.basis});continue}
 if(assignments.has(path))continue;
 // A module family expands to exact known files, never a future-source wildcard.
 const matchesForPath=rules.filter(r=>matches(path,r));const domains=[...new Set(matchesForPath.flatMap(r=>r.domains||[r.domain]))];
 if(domains.length===1)assignments.set(path,{path,domains,basis:matchesForPath.map(r=>r.basis).join('; ')});
 else if(domains.length>1)ambiguous.push({path,candidateDomains:domains});
}
// Canonical command tuples/IDs are retained exactly from the earlier real inventory.
const commands=e.commands.map(c=>{if(c.tuple.command==='npm')return c;return{...c,domains:[...new Set(c.sourceRefs.flatMap(p=>assignments.get(p)?.domains||[]))]}});
const groups=new Map();for(const c of commands)for(const d of c.domains){if(!groups.has(d))groups.set(d,[]);groups.get(d).push(c.id)};
const ids=[...new Set([...assignments.values()].flatMap(a=>a.domains))].filter(id=>id!=='historical-archive').sort();const next={...policy,responsibilities:[...ids.map(id=>({id,paths:[...assignments.values()].filter(a=>a.domains.includes(id)).map(a=>a.path).sort(),hostAdapters:policy.responsibilities.find(r=>r.id===id)?.hostAdapters||[],validationGroups:groups.has(id)?[id+'-checks']:[]})),{...policy.responsibilities.find(r=>r.id==='historical-archive'),paths:[...policy.responsibilities.find(r=>r.id==='historical-archive').paths,...material.archiveOutputPatterns]}].filter(Boolean),validationGroups:[...groups].map(([id,values])=>({id:id+'-checks',commandIds:[...new Set(values)].sort()}))};
const unknown=all.filter(p=>!assignments.has(p));const summary={snapshotHead:e.summary.head,exactAssignments:assignments.size,archivePatterns:next.responsibilities.find(r=>r.id==='historical-archive').paths,unresolvedPaths:unknown.length,unresolvedCode:unknown.filter(p=>/^(packages\/|scripts\/|bin\/)/.test(p)).length,unresolvedCommands:commands.filter(c=>!c.domains.length),ambiguous};
writeFileSync(artifact('policy-refined.json'),JSON.stringify(next,null,2));writeFileSync(artifact('evidence-refined.json'),JSON.stringify({summary,assignments:[...assignments.values()],commands},null,2));writeFileSync(artifact('unresolved-refined.json'),JSON.stringify(unknown,null,2));console.log(JSON.stringify(summary,null,2));
