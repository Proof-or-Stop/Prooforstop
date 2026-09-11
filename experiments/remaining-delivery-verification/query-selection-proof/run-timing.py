from pathlib import Path
import subprocess,json,hashlib,time,statistics
p=Path.cwd();o=p/'output/story-list-red-green';producer=p/'experiments/remaining-delivery-verification/query-read-probe.mjs';root='/Users/jek/Documents/GitHub/Prooforstop'
plan=json.loads((o/'timing-plan.json').read_text()); paths=set()
for arm in ('red','green'):
 for case in plan['cases']:
  d=json.loads((o/f'{arm}-{case}-witness.json').read_text());assert not d['error'] and not d['changedDuringProbe'];paths.update(d['inputs'])
def hashes():
 return {x:hashlib.sha256(Path(x).read_bytes()).hexdigest() if Path(x).is_file() else None for x in sorted(paths)}
before=hashes(); (o/'timing-inputs-before.json').write_text(json.dumps(before,indent=2)+'\n');runs=[];start=time.monotonic()
for case in plan['cases']:
 for pair,order in enumerate(plan['orders'],1):
  for arm in order:
   assert time.monotonic()-start<plan['maxSeconds']
   dist=o/'baseline-checkout/packages/main/dist' if arm=='red' else p/'packages/main/dist'
   t=time.monotonic();r=subprocess.run(['node',str(producer),str(dist),root,case,'no'],capture_output=True,text=True,timeout=60)
   (o/f'timing-{case}-{pair}-{arm}.json').write_text(r.stdout);(o/f'timing-{case}-{pair}-{arm}.stderr').write_text(r.stderr)
   d=json.loads(r.stdout);assert r.returncode==0 and not d['error'];row={'case':case,'pair':pair,'arm':arm,'order':order,'handlerMs':d['elapsedMs'],'processWallSeconds':time.monotonic()-t,'resultSha256':d['resultSha256'],'rows':len(d['rows'])};runs.append(row);print(json.dumps(row),flush=True)
after=hashes();changed=[x for x in before if before[x]!=after[x]];summary=[]
for case in plan['cases']:
 vals={arm:[r['handlerMs'] for r in runs if r['case']==case and r['arm']==arm] for arm in ('red','green')};identical=len(set(r['resultSha256'] for r in runs if r['case']==case))==1
 summary.append({'case':case,'redMedianMs':statistics.median(vals['red']),'greenMedianMs':statistics.median(vals['green']),'redRangeMs':[min(vals['red']),max(vals['red'])],'greenRangeMs':[min(vals['green']),max(vals['green'])],'allOutputDigestsEqual':identical,'observedReductionPercent':100*(1-statistics.median(vals['green'])/statistics.median(vals['red'])) if identical and not changed else None})
result={'scope':'three-pair exploratory handler query timing, not Story lead-time or statistical performance PASS','validInputSnapshot':not changed,'changedInputs':changed,'inputCount':len(before),'runs':runs,'summary':summary,'totalWallSeconds':time.monotonic()-start};(o/'timing-results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'summary':summary,'changedInputs':changed}),flush=True)
