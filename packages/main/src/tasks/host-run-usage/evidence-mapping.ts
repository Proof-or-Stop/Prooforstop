import assert from 'node:assert/strict';



import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';















import { check, root, freshRoot, counter, evidenceMappingCheck, canonicalCore } from "./support.js";

export async function case88(): Promise<void> {


  // =========================================================================
  // Isolation
  // =========================================================================
  check('isolation: all artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()));
    assert.ok(statSync(root).isDirectory());
    // Snapshot before this case writes: earlier selected cases must have left
    // their fixtures under the temp root; a standalone selection has none.
    const entries = readdirSync(root);
    if (counter > 0) assert.ok(entries.length > 0);
    else assert.deepEqual(entries, []);
    // This capability owns its fixture even when selected without other cases.
    const ownedFixture = freshRoot();
    mkdirSync(ownedFixture);
    assert.ok(statSync(ownedFixture).isDirectory());
    assert.ok(ownedFixture.startsWith(root + "/"));
    assert.deepEqual(readdirSync(root).filter(name => !entries.includes(name)), [basename(ownedFixture)]);
  });
}

export async function case89(): Promise<void> {


  // F057: immutable verification receipts pin this command. Execute the two
  // focused boundaries here so its successful exit actually proves their
  // independent candidate-overflow and CLI watchdog contracts.
  evidenceMappingCheck(
    'CHK-004:edge:2 pinned command executes the candidate overflow/null-first-output boundary',
    'candidate-spec-routing-smoke.js',
    'candidate-spec-routing smoke: PASS',
  );
}

export async function case90(): Promise<void> {

  if (!canonicalCore) {
    evidenceMappingCheck(
      'CHK-007:adversarial:2 pinned command executes the CLI runtimeContinuation/watchdog boundary',
      'managed-host-run-command-smoke.js',
      'managed-host-run-command-smoke PASS',
    );
  }
}
