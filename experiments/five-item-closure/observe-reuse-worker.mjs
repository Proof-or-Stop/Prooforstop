import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const impl = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/main/dist');
const { StoryStore } = await import(impl + '/core/store.js');
const { createVerifierHandlers } = await import(impl + '/handlers/verifier.js');
const { acquireOwnerLease } = await import(impl + '/core/story-owner-lease.js');
const [root, output, options] = process.argv.slice(2);
const store = new StoryStore(root), storyId = 'B-labreuse';
acquireOwnerLease(store.storyDirPath(storyId), { command: 'isolated-observe-reuse-test', cwd: root });
const { labMutation, ...validateOptions } = JSON.parse(options);
if (labMutation === 'revoke' || labMutation === 'corrupt-ledger') {
  const { readStoryAwareValidationArtifacts } = await import(impl + '/handlers/story-aware-validation.js');
  const { appendReceiptRevocation } = await import(impl + '/core/story-aware-validation.js');
  const ledger = appendReceiptRevocation(readStoryAwareValidationArtifacts(root, storyId).revocationLedger, ['newly-revoked-fixture-receipt']);
  if (labMutation === 'corrupt-ledger') ledger.signature = 'invalid-fixture-signature';
  writeFileSync(join(root, '.proof-or-stop/runtime/dynamic-validation', storyId, 'revocation-ledger.json'), JSON.stringify(ledger));
}
let mutated = false;
const ctx = { store, root, scanRoot: join(root, 'src'), log: line => {
  process.stderr.write(line + '\n');
  if (!mutated && line === 'observe selection persisted; checking complete PASS freshness again') {
    mutated = true;
    if (labMutation === 'head-during-selection') {
      appendFileSync(join(root, 'src/add.mjs'), '// concurrent committed material\n');
      execFileSync('git', ['add', 'src/add.mjs'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'concurrent fixture change'], { cwd: root });
    }
    if (labMutation === 'evidence-during-selection') {
      const evidence = store.readTestEvidence(storyId); delete evidence.commandExecution; store.writeTestEvidence(storyId, evidence);
    }
  }
} };
const result = await createVerifierHandlers(ctx).validate({ story: storyId, json: true, noSync: true, ...validateOptions });
writeFileSync(output, typeof result === 'string' ? result : JSON.stringify(result));
console.log(result);
