#!/usr/bin/env python3
import argparse,pathlib,json,statistics,hashlib,math
ap=argparse.ArgumentParser();ap.add_argument('evidence',type=pathlib.Path);p=ap.parse_args().evidence
final=json.loads((p/'final-comparison.json').read_text())
def rows(name,prefix):return [json.loads(l[len(prefix):]) for l in (p/(name+'.log')).read_text().splitlines() if l.startswith(prefix)]
for key,red,green,prefix in [('parentAlive','host-red','host-anchor-green','RECOVERY_RESULT '),('parentExitedFirst','orphan-red','orphan-green','ORPHAN_RESULT ')]:
 medians=[]
 for side,name in [('red',red),('green',green)]:
  receipt=json.loads((p/(name+'.json')).read_text());log=(p/(name+'.log')).read_bytes();assert hashlib.sha256(log).hexdigest()==receipt['logSha256']
  assert receipt['exitCode']==(1 if side=='red' else 0)
  r=rows(name,prefix);assert len(r)==3 and all(x['ready'] and x['result']['exitCode']==124 for x in r)
  assert sum(x['descendantCompleted'] for x in r)==(3 if side=='red' else 0)
  median=statistics.median(x['elapsedMs'] for x in r);medians.append(median);assert math.isclose(median,final['recovery'][key][side+'MedianMs'],abs_tol=1e-8)
 assert json.loads((p/(red+'.json')).read_text())['args']==json.loads((p/(green+'.json')).read_text())['args']
 assert math.isclose(100*(1-medians[1]/medians[0]),final['recovery'][key]['returnLatencyReductionPercent'],abs_tol=1e-8)
for side in ['red','green']:
 samples=rows('orphan-'+side,'NORMAL_OVERHEAD_RESULT ')[0];assert len(samples)==7;assert math.isclose(statistics.median(samples),final['normalCommandOverhead'][side+'MedianMs'],abs_tol=1e-8)
assert math.isclose(final['normalCommandOverhead']['greenMedianMs']-final['normalCommandOverhead']['redMedianMs'],final['normalCommandOverhead']['addedMedianMs'],abs_tol=1e-8)
print('FINAL_COMPARISON_VERIFIED: two3+3timeout paths,7+7ordinary overhead samples, no Story speedup inference')
