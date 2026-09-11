from pathlib import Path
import json,re,hashlib,statistics
L=Path.cwd();O=L/'output/fixture-read-scope';rows={}
for arm in ['before-final','after-final']:
 receipt=json.loads((O/(arm+'-execution.json')).read_text());log=(O/(arm+'-full.log')).read_text();lines=log.splitlines()
 assert receipt['exitCode']==0 and receipt['sourceUnchanged'] and receipt['keyRemoved'],arm+' not a complete stable successful arm'
 assert not any(line.startswith('FAIL ') for line in lines)
 cases=[]
 for line in lines:
  if line.startswith('PASS exact public identity mutation '):
   m=re.fullmatch(r'PASS exact public identity mutation (.+) \((consumer-source|origin-only)\) elapsedMs=(\d+)',line);assert m,line
   cases.append({'id':m[1],'kind':m[2],'ms':int(m[3])})
 assert len(cases)==250 and len({(c['id'],c['kind']) for c in cases})==250
 controls=[re.sub(r' elapsedMs=\d+','',line) for line in lines if line.startswith('PASS ') and not line.startswith('PASS exact public identity mutation ') and not line.startswith('PASS canonical public operation timing ')]
 observers=[r for line in lines if line.startswith('IDENTITY_OBSERVER_STATS ') for r in json.loads(line.split(' ',1)[1])]
 rows[arm]={**receipt,'cases':cases,'caseIdentityDigest':hashlib.sha256(json.dumps([(c['id'],c['kind']) for c in cases]).encode()).hexdigest(),'controls':controls,'observerStats':observers,'snapshotMs':sum(r['snapshotMs'] for r in observers),'snapshots':sum(r['snapshots'] for r in observers),'logSha256':hashlib.sha256((O/(arm+'-full.log')).read_bytes()).hexdigest()}
before=rows['before-final'];after=rows['after-final'];newControl='PASS public fixture reads only required history while preserving mutation detection'
assert before['caseIdentityDigest']==after['caseIdentityDigest'],'Missing/reordered/changed mutation cases'
assert before['argv']==after['argv']
assert after['controls'].count(newControl)==1
assert before['controls']==[c for c in after['controls'] if c!=newControl], 'Original successful controls changed or were dropped'
profile=json.loads((O/'profile-pairs.json').read_text());assert len(profile['pairChecks'])==3
profiles={}
for arm in ['red','green']:
 data=[r for r in profile['results'] if r['arm']==arm];assert len(data)==3
 assert len({(r['readBytes'],r['readCalls'],r['materialDigest'],r['outsideProjectionDigest']) for r in data})==1
 profiles[arm]={k:statistics.median(r[k] for r in data) for k in ['setupMs','snapshotMs','setupAndSnapshotMs','readBytes','readCalls','uniqueReadPaths','indexedMaterialRows']}
reduce=lambda a,b:100*(a-b)/a
result={'scope':'Existing Lab repairs plus identical prerequisite identity-witness correction in both arms; only private fixture projection differs. One successful sequential full-command pair on shared host plus three alternating paired snapshot profiles. Not whole Story delivery time.', 'rows':rows,'all250CaseIdentitiesAndOrderPreserved':True,'allOriginalControlsPreserved':True,'additionalControl':newControl,'commandReductionPercent':reduce(before['commandSeconds'],after['commandSeconds']),'includingOuterPreparationReductionPercent':reduce(before['commandSeconds']+before['setupSeconds'],after['commandSeconds']+after['setupSeconds']),'observerSnapshotReductionPercent':reduce(before['snapshotMs'],after['snapshotMs']),'profiles':profiles,'logicalReadByteReductionPercent':reduce(profiles['red']['readBytes'],profiles['green']['readBytes']),'profileSnapshotMedianReductionPercent':reduce(profiles['red']['snapshotMs'],profiles['green']['snapshotMs']),'profileSetupAndSnapshotMedianReductionPercent':reduce(profiles['red']['setupAndSnapshotMs'],profiles['green']['setupAndSnapshotMs']),'preregisteredPracticalThresholdPercent':10,'limitations':['Single full-command pair; fixed before/after order; shared workstation load and filesystem cache not controlled.','The first two failed prerequisite attempts are retained separately and are excluded from successful-arm performance comparison.','Logical snapshot readFileSync bytes are neither total physical disk reads nor memory use; fixture Git preparation is timed separately.','Original 250 registered identity mutations and specified filesystem controls are preserved; this is not proof against arbitrary future defects.','No main integration, global session migration, arbitrary Story speedup or cleanup of actual history.']}
result['preregisteredPracticalThresholdMet']=result['commandReductionPercent']>=10
(O/'comparison.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['rows','limitations']},ensure_ascii=False))
