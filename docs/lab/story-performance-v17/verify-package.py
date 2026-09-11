#!/usr/bin/env python3
"""Verify the preserved comparison table and bundled public evidence."""
from pathlib import Path
import hashlib, json
root = Path(__file__).resolve().parent
binding = json.loads((root / 'historical-table-binding.json').read_text())
report = (root / 'REPORT.md').read_bytes()
assert report == (root / 'HISTORICAL-COMPARISON-FROZEN.md').read_bytes(), 'historical copy changed'
assert hashlib.sha256(report).hexdigest() == binding['sha256'], 'historical digest mismatch'
text = report.decode()
table = text[text.index('|问题|'):text.index('\n## 未关闭')].strip()
assert len(table.splitlines()) == 26, 'expected 24 comparison rows plus header'
assert table in (root / 'RELEASE-NOTES.md').read_text(), 'release must embed the original table'
manifest = json.loads((root / 'evidence-manifest.json').read_text())
for item in manifest:
    target = root / item['path']
    assert target.resolve().is_relative_to(root), 'manifest escapes package'
    data = target.read_bytes()
    assert len(data) == item['bytes'], item['path'] + ': size mismatch'
    assert hashlib.sha256(data).hexdigest() == item['sha256'], item['path'] + ': digest mismatch'
print('PACKAGE_GREEN: 24 comparison rows preserved; release table identical; %d evidence files verified' % len(manifest))
