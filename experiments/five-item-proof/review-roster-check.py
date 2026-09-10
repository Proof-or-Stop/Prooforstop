"""Audit this Lab's actual review roster; no claim about unrelated live Stories."""
from pathlib import Path
import json, re, copy, sys

def require(condition, message):
    if not condition:
        raise AssertionError(message)

def validate(contract, owner, rows):
    require(owner and owner['digest'] == contract['runtimeDigest'], 'missing or mismatched owner identity')
    require(owner['fileCount'] == len(owner['files']) > 0, 'owner file inventory incomplete')
    expected = {(a, w, r) for (a, ws) in contract['arms'].items() for w in ws for r in contract['roles']}
    require(len(rows) == len(expected), 'missing or extra reviewer')
    seen = set()
    for row in rows:
        key = tuple(row['key'])
        require(key in expected and key not in seen, 'duplicate or unrequested reviewer')
        seen.add(key)
        require(row['identity'] == owner, 'full implementation identity differs despite digest label')
        require(row['execution']['exitCode'] == 0 and row['execution']['sourceUnchanged'], 'review process failed or packet changed')
        events = row['events']
        first = None
        result = None
        for event in events:
            content = event.get('message', {}).get('content', [])
            if not isinstance(content, list):
                continue
            for c in content:
                if first is None and c.get('type') == 'tool_use' and (c.get('name') == 'Bash'):
                    first = c
                if first and c.get('type') == 'tool_result' and (c.get('tool_use_id') == first['id']):
                    result = c
        require(first and result and (not result.get('is_error')), 'missing or failed actual handshake tool result')
        command = first['input']['command']
        require(re.search('(?:^|&&\\s*)(?:\\./|/[^\\s;]+/)pinned-cli\\.sh --implementation-identity > [^;]+; echo "exit=\\$\\?"', command), 'first command is not the actual pinned identity invocation')
        body = result.get('content', '')
        require(isinstance(body, str) and re.search('^exit=0(?:\\n|$)', body), 'CLI exit zero not witnessed')
    require(seen == expected, 'roster validation invariant failed')
    return {'owner': 1, 'reviewers': len(rows), 'participants': 1 + len(rows), 'completeFullIdentityMatch': True, 'actualCliExitZero': len(rows)}

def read_roster(base):
    contract = json.loads((base / 'preregistered.json').read_text())
    owner = json.loads((base / 'owner-identity.json').read_text())
    rows = []
    for (a, ws) in contract['arms'].items():
        for w in ws:
            for r in contract['roles']:
                p = base / 'runs' / a / w / r
                rows.append({'key': [a, w, r], 'identity': json.loads((p / 'identity.json').read_text()), 'execution': json.loads((p / 'execution.json').read_text()), 'events': [json.loads(l) for l in (p / 'stream.jsonl').read_text().splitlines()]})
    return (contract, owner, rows)
if __name__ == '__main__':
    base = Path(sys.argv[1])
    (c, o, rows) = read_roster(base)
    report = validate(c, o, rows)
    controls = []

    def refused(name, owner, rr):
        try:
            validate(c, owner, rr)
        except AssertionError as e:
            controls.append({'name': name, 'rejected': True, 'reason': str(e)})
            return
        raise AssertionError('bad roster accepted: ' + name)
    refused('missing owner', None, rows)
    refused('missing reviewer', o, rows[:-1])
    refused('duplicate reviewer', o, rows[:-1] + [rows[0]])
    rr = copy.deepcopy(rows)
    rr[0]['identity']['fileCount'] -= 1
    refused('same digest with incomplete file body', o, rr)
    rr = copy.deepcopy(rows)
    rr[0]['events'] = []
    refused('identity file without execution trace', o, rr)
    rr = copy.deepcopy(rows)
    for e in rr[0]['events']:
        for b in e.get('message', {}).get('content', []) if isinstance(e.get('message', {}).get('content', []), list) else []:
            if b.get('type') == 'tool_result' and isinstance(b.get('content'), str):
                b['content'] = b['content'].replace('exit=0', 'exit=1')
    refused('failed CLI masked by successful later shell command', o, rr)
    rr = copy.deepcopy(rows)
    rr[0]['identity']['runtime']['version'] = 'different-runtime'
    refused('runtime differs under copied digest', o, rr)
    for index in range(len(rows)):
        changed=list(rows)
        changed[index]={**rows[index], 'identity':{**rows[index]['identity'], 'fileCount': rows[index]['identity']['fileCount']-1}}
        refused('full identity checked at roster position '+str(index),o,changed)
    report.update({'negativeControls': controls, 'scope': 'All enrolled participants of the retained Lab calibration only; no hostile-host attestation or unrelated live-session census.'})
    pathlib_output=Path(sys.argv[2]) if len(sys.argv)>2 else base/'roster-verified.json'
    pathlib_output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
