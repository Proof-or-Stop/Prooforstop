import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertCanonicalActiveIdentityBoundary } from '../packages/main/dist/core/runtime-environment-checks.js';
const root = mkdtempSync(join(tmpdir(), 'inventory-consumer-binding-'));
try {
  for (const path of ['core/review-inventory-epoch.js', 'core/verification-execution-evidence.js', 'handlers/checklist.js', 'core/maintenance-command-mode.js', 'core/artifact-schema.js']) {
    const target = join(root, 'dist', path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve('packages/main/dist', path), target);
  }
  const verify = () => assertCanonicalActiveIdentityBoundary({ boundaryId: 'review-inventory-epoch', runtimePackageRoot: root, projectRoot: root });
  verify();
  const path = join(root, 'dist/core/review-inventory-epoch.js');
  const original = readFileSync(path, 'utf8');
  const changed = original.replace("return 'proof-or-stop session_brief';", "return 'proof-or-stop unexpected_action';");
  assert.notEqual(changed, original, 'mutation must change the actual consumer implementation');
  writeFileSync(path, changed);
  assert.throws(verify, /consumer rejected active identity bytes; executable declaration\/producer\/consumer binding changed/, 'unchanged protocol labels do not authorize changed executable behavior');
  writeFileSync(path, original.replace('proof-or-stop.review_inventory_epochs.v1', 'unsupported.review_inventory_epochs.v1'));
  assert.throws(verify, /consumer rejected/, 'a wrong active protocol remains refused');
  writeFileSync(path, original);
  verify();
  const helperPath = join(root, 'dist/core/maintenance-command-mode.js');
  const helper = readFileSync(helperPath, 'utf8');
  writeFileSync(helperPath, helper + '\nexport const unreviewedDelegate = true;\n');
  assert.throws(verify, /maintenance-command-mode.*consumer rejected active identity bytes/, 'preview delegation remains implementation-bound');
  writeFileSync(helperPath, helper); verify();
  console.log('PASS inventory consumer binding: canonical accepted, behavioral change rejected, wrong protocol rejected, exact restoration accepted');
} finally { rmSync(root, { recursive: true, force: true }); }
