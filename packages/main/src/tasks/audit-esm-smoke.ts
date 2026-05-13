import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMechanicalAudit } from '../core/audit-scan.js';

const root = mkdtempSync(join(tmpdir(), 'koala-audit-esm-'));

try {
  const mdPath = join(root, 'CLAUDE.md');
  writeFileSync(mdPath, [
    '# Test CLAUDE',
    '',
    '```bash',
    'koala validate --json',
    'koala missing_cmd',
    '```',
    '',
  ].join('\n'), 'utf-8');

  const report = runMechanicalAudit([mdPath], root, {
    registryNames: new Set(['validate']),
    runHelp: (cmd) => cmd === 'validate'
      ? { ok: true, output: '--json\n' }
      : { ok: false, reason: 'exit-nonzero', output: 'unknown command' },
    grepLiteral: () => true,
    pathExists: () => true,
  });

  assert.equal(
    report.drifts.some(d => d.symbol === 'koala missing_cmd' && d.driftType === 'missing-command'),
    true,
    'registry docs-drift branch should complete and preserve missing command drift',
  );
  console.log('audit-esm-smoke ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
