"""Audit this Lab's actual review roster; no claim about unrelated live Stories."""
from pathlib import Path
import json, re, copy, sys

def validate(contract, owner, rows):
    assert owner and owner['digest']==contract['runtimeDigest'], 'missing or mismatched owner identity'
    assert owner['fileCount']==len(owner['files'])>0, 'owner file inventory incomplete'
    expected={(a,w,r) for a,ws in contract['arms'].items() for w in ws for r in contract['roles']}
    assert len(rows)==len(expected), 'missing or extra reviewer'
    seen=set()
    for row in rows:
        key=tuple(row['key']); assert key in expected and key not in seen, 'duplicate or unrequested reviewer'
        seen.add(key)
        assert row['identity']==owner, 'full implementation identity differs despite digest label'
        assert row['execution']['exitCode']==0 and row['execution']['sourceUnchanged'], 'review process failed or packet changed'
        events=row['events']; first=None; result=None
        for event in events:
            content=event.get('message',{}).get('content',[])
            if not isinstance(content,list):continue
            for c in content:
                if first is None and c.get('type')=='tool_use' and c.get('name')=='Bash':first=c
                if first and c.get('type')=='tool_result' and c.get('tool_use_id')==first['id']:result=c
        assert first and result and not result.get('is_error'), 'missing or failed actual handshake tool result'
        command=first['input']['command']
        # The retained calls use one of two explicit command forms; an echo of
        # a wrapper name cannot count as execution. Exit is captured immediately.
        assert re.search(r'(?:^|&&\s*)(?:\./|/[^\s;]+/)pinned-cli\.sh --implementation-identity > [^;]+; echo "exit=\$\?"',command), 'first command is not the actual pinned identity invocation'
        body=result.get('content','')
        assert isinstance(body,str) and re.search(r'^exit=0(?:\n|$)',body), 'CLI exit zero not witnessed'
    assert seen==expected
    return {'owner':1,'reviewers':len(rows),'participants':1+len(rows),'completeFullIdentityMatch':True,'actualCliExitZero':len(rows)}

def read_roster(base):
    contract=json.loads((base/'preregistered.json').read_text());owner=json.loads((base/'owner-identity.json').read_text());rows=[]
    for a,ws in contract['arms'].items():
        for w in ws:
            for r in contract['roles']:
                p=base/'runs'/a/w/r
                rows.append({'key':[a,w,r],'identity':json.loads((p/'identity.json').read_text()),'execution':json.loads((p/'execution.json').read_text()),'events':[json.loads(l) for l in (p/'stream.jsonl').read_text().splitlines()]})
    return contract,owner,rows

if __name__=='__main__':
    base=Path(sys.argv[1]);c,o,rows=read_roster(base);report=validate(c,o,rows);controls=[]
    def refused(name,owner,rr):
        try:validate(c,owner,rr)
        except AssertionError as e:controls.append({'name':name,'rejected':True,'reason':str(e)});return
        raise AssertionError('bad roster accepted: '+name)
    refused('missing owner',None,rows);refused('missing reviewer',o,rows[:-1]);refused('duplicate reviewer',o,rows[:-1]+[rows[0]])
    rr=copy.deepcopy(rows);rr[0]['identity']['fileCount']-=1;refused('same digest with incomplete file body',o,rr)
    rr=copy.deepcopy(rows);rr[0]['events']=[];refused('identity file without execution trace',o,rr)
    rr=copy.deepcopy(rows)
    for e in rr[0]['events']:
        for b in e.get('message',{}).get('content',[]) if isinstance(e.get('message',{}).get('content',[]),list) else []:
            if b.get('type')=='tool_result' and isinstance(b.get('content'),str):b['content']=b['content'].replace('exit=0','exit=1')
    refused('failed CLI masked by successful later shell command',o,rr)
    rr=copy.deepcopy(rows);rr[0]['identity']['runtime']['version']='different-runtime';refused('runtime differs under copied digest',o,rr)
    report.update({'negativeControls':controls,'scope':'All enrolled participants of the retained Lab calibration only; no hostile-host attestation or unrelated live-session census.'})
    (base/'roster-verified.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
