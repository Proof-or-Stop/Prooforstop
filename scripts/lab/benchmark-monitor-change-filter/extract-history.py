"""Read a bounded historical audit subset; export facts/usage, never transcript prose."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('audit', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--subset', type=int, default=1)
args = parser.parse_args()
audit_bytes = args.audit.read_bytes()
audit = json.loads(audit_bytes)
subset = audit['heartbeat_subsets'][args.subset]
ids = set(subset['turn_ids'])
source = Path(audit['root']['source_path'])
decoder = json.JSONDecoder()


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)
    elif isinstance(value, str):
        for offset, char in enumerate(value):
            if char == '{':
                try:
                    child, _ = decoder.raw_decode(value, offset)
                except ValueError:
                    continue
                yield from objects(child)


rows = {}
current = None
seen_responses = set()
prefix = hashlib.sha256()
prefix_bytes = 0
fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
required = {'at', 'phases', 'main', 'scopeStatus', 'bindingDigest', 'approvalContinuityRefusal'}
with source.open('rb') as stream:
    for line_number, raw in enumerate(stream, 1):
        record = json.loads(raw)
        if timestamp(record['timestamp']) >= timestamp(subset['end_exclusive_utc']):
            break
        prefix.update(raw)
        prefix_bytes += len(raw)
        payload = record.get('payload', {})
        if record['type'] == 'event_msg' and payload.get('type') == 'task_started':
            current = payload.get('turn_id')
            if current in ids:
                rows.setdefault(current, {'turn_id': current, 'start': record['timestamp'], 'candidates': [],
                                          'usage': {key: 0 for key in fields}, 'responses': 0})
        if record['type'] == 'token_usage_record' and payload.get('turn_id') in rows:
            response = payload['response_id']
            if response not in seen_responses:
                seen_responses.add(response)
                row = rows[payload['turn_id']]
                for key in fields:
                    row['usage'][key] += payload['usage'][key]
                row['responses'] += 1
        if current not in rows:
            continue
        row = rows[current]
        if record['type'] == 'event_msg' and payload.get('type') == 'task_complete':
            row['end'] = record['timestamp']
            row['final_classification'] = 'DONT_NOTIFY' if 'DONT_NOTIFY' in str(payload.get('last_agent_message')) else 'other'
        if record['type'] == 'response_item' and payload.get('type') in ('custom_tool_call_output', 'function_call_output'):
            for item in objects(payload.get('output')):
                if required <= item.keys() and timestamp(item['at']) >= timestamp(row['start']):
                    row['candidates'].append({'at': item['at'], 'source_line': line_number,
                                             'facts': {key: item[key] for key in sorted(required - {'at'})}})

accepted, excluded = [], []
for turn_id in subset['turn_ids']:
    row = rows.get(turn_id)
    candidates = [] if not row or 'end' not in row else [
        item for item in row['candidates'] if timestamp(item['at']) <= timestamp(row['end'])]
    if not candidates:
        excluded.append({'turn_id': turn_id, 'reason': 'no recoverable fresh completed-turn observation'})
        continue
    accepted.append({key: value for key, value in row.items() if key != 'candidates'} | candidates[-1])

total_usage = {key: sum(row['usage'][key] for row in rows.values()) for key in fields}
if total_usage != {key: subset['usage'][key] for key in fields}:
    raise ValueError('Per-response usage does not reconcile with the historical audit')
accepted.sort(key=lambda row: timestamp(row['start']))
result = {
    'scope': 'Historical scope/phase/revision projection only; execution completeness is NOT proven by this transcript',
    'source_path': str(source), 'source_prefix_bytes': prefix_bytes, 'source_prefix_sha256': prefix.hexdigest(),
    'audit_path': str(args.audit), 'audit_sha256': hashlib.sha256(audit_bytes).hexdigest(),
    'window': {key: subset[key] for key in ('start_inclusive_utc', 'end_exclusive_utc')},
    'original_turns': len(ids), 'original_usage': total_usage,
    'accepted_usage': {key: sum(row['usage'][key] for row in accepted) for key in fields},
    'excluded': excluded, 'observations': accepted,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'accepted': len(accepted), 'excluded': len(excluded), 'accepted_usage': result['accepted_usage']}))
