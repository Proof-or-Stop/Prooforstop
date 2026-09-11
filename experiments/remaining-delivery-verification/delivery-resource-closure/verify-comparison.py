#!/usr/bin/env python3
import argparse,json,pathlib,hashlib,statistics,math
ap=argparse.ArgumentParser();ap.add_argument('evidence',type=pathlib.Path);p=ap.parse_args().evidence
summary=json.loads((p/'comparison.json').read_text());receipts={}
for side in ['red','green']:
 r=json.loads((p/('resource-'+side+'.json')).read_text());b=(p/('resource-'+side+'.log')).read_bytes();assert hashlib.sha256(b).hexdigest()==r['logSha256'];assert r['exitCode']==(1 if side=='red' else 0);receipts[side]=r
 rows=[json.loads(l.split(' ',1)[1]) for l in b.decode().splitlines() if l.startswith('RESOURCE_FLOW_RESULT ')];cost=[json.loads(l.split(' ',1)[1]) for l in b.decode().splitlines() if l.startswith('NORMAL_COST_RESULT ')][0]
 assert len(rows)==3 and len(cost)==7
 assert all(x['firstExit']==x['secondExit']==0 and x['firstResult']=='owner-complete' and x['secondResult']=='consumer-complete' for x in rows)
 assert sum(x['backgroundCompleted'] for x in rows)==(3 if side=='red' else 0)
 assert rows==summary[side]['flowRows'] and cost==summary[side]['ordinarySamplesMs']
 for field,values in [('totalMedianMs',[x['totalMs'] for x in rows]),('waitingMedianMs',[x['waitMs'] for x in rows]),('ordinaryMedianMs',cost)]:assert math.isclose(statistics.median(values),summary[side][field],abs_tol=1e-8)
 assert 'PASS exact2MiB stdout and2MiB stderr' in b.decode()
 u=[json.loads(l.split(' ',1)[1]) for l in b.decode().splitlines() if l.startswith('UNVERIFIED_CLEANUP_RESULT ')][0];assert u['exitCode']==(0 if side=='red' else 1)
 if side=='green':assert u['terminalReason']=='child_error' and 'HOST_GROUP_CLEANUP_UNVERIFIED' in u['stderr']
assert receipts['red']['args']==receipts['green']['args'] and receipts['red']['testSha256']==receipts['green']['testSha256']
assert math.isclose(100*(1-summary['green']['totalMedianMs']/summary['red']['totalMedianMs']),summary['flowTimeReductionPercent'],abs_tol=1e-8)
assert math.isclose(summary['green']['ordinaryMedianMs']-summary['red']['ordinaryMedianMs'],summary['ordinaryAddedMedianMs'],abs_tol=1e-8)
print(json.dumps({'verdict':'PASS','pairedSuccessfulFlows':3,'normalSamplesPerSide':7,'totalMedianMs':{s:summary[s]['totalMedianMs'] for s in ['red','green']},'waitingMedianMs':{s:summary[s]['waitingMedianMs'] for s in ['red','green']},'scope':'Specific real resource-dependent command flow only; no real Story/global adoption inference'},indent=2))
