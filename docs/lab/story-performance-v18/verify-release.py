#!/usr/bin/env python3
"""Check English release text, unchanged measurements, and attached evidence."""
from pathlib import Path
import hashlib, json, re
root = Path(__file__).resolve().parent
release = (root / 'RELEASE-NOTES.md').read_text()
assert not re.search(r'[\u3400-\u9fff\uf900-\ufaff]', release), 'release contains CJK text'
comparison = release[release.index('| Issue |'):release.index('\n## Repairs')]
rows = [line for line in comparison.splitlines() if line.startswith('|')]
assert len(rows) == 26, 'expected exactly 24 comparison rows and two header rows'
assert '0.3.316' in release
assert 'Historical reuse-smoke assertion' in release
checks = json.loads((root / 'translation-check.json').read_text())
assert len(checks['rows']) == 24 and all(r['decimalMeasurementsPreserved'] for r in checks['rows'])
manifest = json.loads((root / 'evidence-manifest.json').read_text())
for row in manifest:
    path = root / row['path']
    assert path.resolve().is_relative_to(root), 'path escapes evidence root'
    data = path.read_bytes()
    assert len(data) == row['bytes'], row['path']
    assert hashlib.sha256(data).hexdigest() == row['sha256'], row['path']
print('RELEASE_PACKAGE_GREEN: English release; 24 comparison rows; historical failure disclosed; %d evidence files verified' % len(manifest))
