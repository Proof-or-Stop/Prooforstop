
import { readFileSync } from 'node:fs';













export const EXACT_ALLOWLIST = [
  ['historical-reader-process-execution', 'packages/main/src/core/process-fact-registry.ts', 'lattice.execution_boundary.v1', 'f77165cdd6f2608bc3cfec9c450795a758fb6de0be41245aee58bd77658a4f03'],
  ['historical-reader-process-freeze', 'packages/main/src/core/process-fact-registry.ts', 'lattice.scope_freeze_check.v1', '236c06ef571dd5d117f0e0c6f582a89f8436347334047ef57886cb5ab4f22f2e'],
  ['historical-reader-core-scope', 'packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_boundary.v1', '59a314a125e3e9f539848041d2cd43377f2c03f7b499e4f25355f661a0718503'],
  ['historical-reader-core-execution', 'packages/main/src/core/scope-anti-expansion.ts', 'lattice.execution_boundary.v1', '9ca17eb94a8193bce2e6d06bc5cced918e7f9e785c2b7ce2f81d6c3b49d61083'],
  ['historical-reader-core-freeze', 'packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_freeze_check.v1', '4b2a6d017fb4f862d51d0114af037f843c1bfeb144b94d62428f20c0a7524a5d'],
  ['historical-reader-type-scope', 'packages/main/src/core/types.ts', 'lattice.scope_boundary.v1', '118091a9a25e90cd0e7edec022b23c0f51a2a88c9e7003ea0ad331b39b3c90fd'],
  ['historical-reader-type-execution', 'packages/main/src/core/types.ts', 'lattice.execution_boundary.v1', 'f2f3d4af743b17d5d6909164eaf499796d75b4df087cca126d7f565942d174be'],
  ['historical-reader-type-freeze', 'packages/main/src/core/types.ts', 'lattice.scope_freeze_check.v1', '8a691420508dafd91e443aad3d2533b5a8f43ac03ee14fd6502d56baff07a9bb'],
].map(([id, path, token, contextSha256]) => ({
  id,
  class: 'persisted_schema',
  path,
  token,
  expectedOccurrences: 1,
  reason: 'Exact signed historical scope schema reader; current writers emit only the canonical proof-or-stop schema.',
  disposition: 'frozen',
  contextSha256,
  verificationCommand: 'node packages/main/tests/canonical-new-story-artifacts.test.mjs --group=scope',
  expectedVerification: 'GREEN B-49df: scope group pass.',
}));

export const EXACT_FROZEN_ROWS = [
  ['provenance_bytes', 'docs/requirements/NAV.md', 'legacy-to-lattice-role-naming-execution-plan.md', 1, '935d4532c30cadb40d7e117085260f5cbe565a1cbd811d5d016b6feaf7e4e211'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-customer-api-key-access', 1, '145f3c49ef9b5066ca3bd358d37c410fa3a48ce2dec8213ba5107068c67e7305'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-live-integration', 1, '6047759e7992cfc31e1e22c0cf3f8240390cbb70c21b4a682f18a742a2f77f84'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-m1-m16-generated-proof-and-live-e2e', 1, '6ae929ca7a871911ba02aed864fec342af6e64bdb6ee3e98f5d0e984275b141d'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-receipt-contract', 1, '256c2b423b39d03998c696763aeb9afaf35e58f1cead655407d4d03cd484ef27'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-authority-remote-evidence-bundle', 1, '8fe4973021c95cebd3198d72f84ed0685b9f928f035dc632f8b6a1fe59ed0933'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-baseline-two-host-multi-agent-execution-plan', 1, 'b9e410faaa299c74014cd86e5374555992a1b64f22a5190543eefd43257bbb77'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-cli-authority-client-receipt-ref', 1, '8468b9a76bdca3e6194bc82a10474a3b5126e0800c5dd6c4d0016471d81a4258'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-codex-command-boundary-execution-plan', 1, '8e6b2bd7ea6a051e481b181d1acfd546aa7908e0703ebf627ef5233537d92ce7'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-console-demo-mvp-requirements', 1, '2e581bd4eb24653f660af579599b1d6ae36e1952e6ae7d81ccbd980857792b6a'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-experience-layer-effectiveness-record', 1, '8282807fb27e7677cece9ca667ad85d22d035c62e2d69021e06f05406d5a67a4'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-experience-layer-execution-plan', 1, '47fa61f075d5348941c60271415ddeec04078ca773ce0c549a8464b09e283392'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-experiment-protocol', 1, '67ed3fb59ad54a3e112119a9fe289f52ad95cc1cc028d9fe55458458bd7808aa'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-llm-usage-ledger-execution-plan', 1, '19d976d4ae8e130d3e095866485e613e04e3837c25cb1c0ce0ce7962b4d94be9'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-midflight-story-repair-and-gitroot-worktree-plan', 1, '62dedbdf0f07efe9a1e7347eed09d1591cbe9eab8d03bd4353c879261cd14d48'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-parallel-wave', 1, 'c539be4cb1276099259a28f68c219e52f2c506f4b29ceedbac9ec504129d1116'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-runtime-owned-agent-assets-execution-plan', 1, 'efd7176bb67a19162e712af55fdfff6f98c35b84a3ccb7bc4d635d2b713d2697'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-strengthening-roadmap-execution-plan', 1, '9612102499987c720eff36393e906ba34aa80affc0f5f2b2bd8dd339383f8e6f'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-lifecycle-readiness-check-execution-plan', 1, 'b3275de6b554c91d41d738e42f7a2e294410de99790c56a016db540ca63cbec2'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-workflow-efficiency-baseline', 1, '4e864806de91b65847eb77febd289ced3fc89493c659745e2d369a5e655b09aa'],
  ['provenance_bytes', 'docs/requirements/NAV.md', 'lattice-unattended-completion-plan', 1, '9d64a82f1570703511fd50d40f86f94a7d2d72fc936e0c35eee63f1308492c14'],
  ['persisted_schema', 'experiments/configs/lab-reviewer-history-v1.json', 'lattice-lab', 1, '7db70f605dce28dfbae47e77210e3c5b90168feb75fa8f1894279dfc68af0aa9'],
  ['persisted_schema', 'experiments/configs/lab-reviewer-reviewer-quality-v1.json', 'lattice-lab', 1, '7db70f605dce28dfbae47e77210e3c5b90168feb75fa8f1894279dfc68af0aa9'],
  ['signature_salt', 'experiments/role-prompt-ab-replay/corpus.json', 'lattice-finding-integrity-v1', 2, 'b36ceef181ab304d6d99527b7139f5cc952b2e6a135934952c59f61860761596'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_RECORD_READONLY', 1, '51ae7cf847cf2142cb327d3e66ba6bcd7d6121a4b9b32d1063f8fde4a452cffe'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_ROLE', 1, '992ce2da579b0d750bf6c8957071e87a0507ec0228ca94aa7100232716fd044c'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_SESSION', 1, '4f4e59cd71bf316da7cf2e33c0c6e71c27e8959f81956f08082dc21cf04c17e9'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_ACTIVITY_SOURCE', 1, '9fb42a6ff820e71305519c45deb668fe09a768528f0a58d54846ef003c976344'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_AGENT', 1, '6674f9db65a696f1a2ed7eb77a9762e8ddd23943be98c2f86ea107a0d8b7b4b1'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_CODEX_ENTRYPOINT', 1, '496789846c25c9fd9c79cf58e85c414744cac0c9d0a2940ef26bb993140ab156'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_AGENT', 1, 'a08bdd1f15130257283852c1fd5ecfb181253d7a64a4ee942850209329502af8'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY', 1, 'f51b59936664aacfcd9f4bba043cf54f046423281dcff2b0135f5326334d8634'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_GENERATED', 1, '4879c731640e9938b3f3554eb79b11fbf889577c48676818c1f6fa3ee4a7b281'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER', 1, 'f4122a3cba70dcd9461f43a73ffe63477d30d3ccde33f625e218b1735238d76a'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_ROLE', 1, 'bafd396911e28226a1011fb3b639d62a57fd0155aa052082d4faccbf2e73a99e'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_SESSION', 1, 'f525c0c8d73482f6bea256e3ca674fa4d9749f1f0c0657bb3aa1be648dfef88c'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_OWNER_SESSION_ADAPTER_TASK', 1, 'e0d673fabcd18799eaee868d0f77b5f81b56fb9883770ce5f61a49dbc5d7bbc8'],
  ['persisted_schema', 'packages/main/src/core/validation-command-environment.ts', 'LATTICE_SESSION_ID', 1, 'd9f5e5b83ecd524e196481c856a7e0c4c9cb83ea212b2eca97ac551676471579'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_RECORD_READONLY', 1, '4d5f19da55d879cffa78ce0862c5b12ef51263134be1dac6aeebb4f8334d769c'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_ROLE', 1, 'd6cb599a8efd8385092d53ab37359eb6d3b2c6c8e843af74940dafefe33c70ff'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_SESSION', 1, 'eea80fcf31138563f7ad029b98d24dbd6fd7f6cf97eb1cb8487758aa1ed2b451'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_ACTIVITY_SOURCE', 1, '732954f703dd7db84565c2c2fe3a84893e14aa89746980d17bc17730cd4e53b3'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_AGENT', 1, 'e2fcec1376b10c722fb4934d01e61b95dfc61117d3d055448a255654494e509c'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_CODEX_ENTRYPOINT', 1, 'dcc818f2a667df12d4d782e9cfa3bf80bcac2a82d0f4ec67c994b8e1488b12fb'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_AGENT', 1, '99e7ac65480624cbc7e8a0ca8e3f42dd0cbb9ab955255d1d8785881771fcc1bb'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY', 1, 'b4a0d71d1ff6f9c18b4dd464306f634595e0d688ddf674dad385d99291a70097'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_GENERATED', 1, '1c52a398bb94fa4bc680fc18d20cbfd993e2e27b505628893973e8fed421b9b4'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER', 1, '0c579a2faa3b6c56321e8163fe98aa8560d1236b17c54134bdb2e78a5ebc499d'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_ROLE', 1, '8032c928b43a575592e43833c3cd55863840b77a4aa2ff6141b40bf7f025b9f7'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_SESSION', 1, 'c09043e6c49514c606d0e9bf8f277633d1859ebd494cfed1f43b40bc106460c3'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_OWNER_SESSION_ADAPTER_TASK', 1, 'f54c46b498f1d1647014a5c7584bf4bf9aac76c43af1aaffb7de6db62abf811c'],
  ['persisted_schema', 'scripts/verify-process-fact-contract.mjs', 'LATTICE_SESSION_ID', 1, '95c69d3e9bd3b405a5e8a7a28b3b7d15da63b4dbb615d1dbf643717244552ef0'],
  ['migration_input', 'packages/main/src/core/acceptance-topology.ts', 'lattice acceptance_matrix', 1, 'e00117fac7f8941f1334c3a2ac0f9ed8bccfa52e2bb546d07cd907ab9b98d3b7'],
  ['migration_input', 'packages/main/src/core/acceptance-topology.ts', 'bin/lattice', 1, 'fcb8e41c228b96e553f807e1427d4506988e6edb39cfa7dc431102718a3f782f'],
  ['compatibility_fixture', 'packages/main/tests/acceptance-topology-provenance.test.mjs', 'lattice acceptance_matrix', 1, 'e289de43360d9d12e87862b2304cab26b869a9ad08f3772d7d6bb59ca43719bc'],
  ['compatibility_fixture', 'packages/main/tests/acceptance-topology-provenance.test.mjs', 'bin/lattice', 1, 'cee7076229d43b1211bdc0ed3d497b732a6edc9f67819ce1eb0ebc4247841b52'],
].map(([className, path, token, expectedOccurrences, contextSha256], index) => ({
  id: `frozen-current-${String(index + 1).padStart(2, '0')}`,
  class: className, path, token, expectedOccurrences, contextSha256,
  reason: className === 'persisted_schema'
    ? token.startsWith('LATTICE_')
      ? 'Persisted validation receipt hashes bind this exact historical transport key; the active filter maps it to the canonical key without changing stored evidence.'
      : 'Existing experiment.v1 schema namespace remains frozen while active package routing is canonical.'
    : className === 'signature_salt'
      ? 'Historical signatures bind this exact salt at this exact verification occurrence.'
      : className === 'migration_input'
        ? 'The non-evidentiary provenance parser recognizes this exact retired producer spelling only when reading frozen historical acceptance records.'
        : className === 'compatibility_fixture'
          ? 'The focused compatibility regression pins this exact retired producer spelling and proves it does not restore an active runtime alias.'
      : 'Exact historical decision title or filename reference remains linked to immutable provenance.',
  disposition: 'frozen',
  verificationCommand: 'internal:verify-exact-frozen-occurrence',
  expectedVerification: 'PASS exact frozen occurrence and context',
}));

EXACT_ALLOWLIST.push(...EXACT_FROZEN_ROWS);

export const CURRENT_LEGACY_CONTEXT_ROWS = JSON.parse(readFileSync(
  new URL(".././proof-or-stop-identity-current-legacy-contexts.json", import.meta.url),
  'utf8',
));

EXACT_ALLOWLIST.push(...CURRENT_LEGACY_CONTEXT_ROWS);

EXACT_ALLOWLIST.push(...[
  {
    "id": "capability-plan-historical-1",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": "live-`.lattice` M0",
    "expectedOccurrences": 1,
    "contextSha256": "d14ee35156bbc1cac7d04bf58bf378903c631cac1c22c435b55cb5f20c9d6ca3",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  },
  {
    "id": "capability-plan-historical-2",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": ".lattice/artifact-releases.jsonl",
    "expectedOccurrences": 2,
    "contextSha256": "1f1741bdeb2d1815781f2c0a3b5e69f8230ee5929589f2c023f25990f7485f39",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  },
  {
    "id": "capability-plan-historical-3",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": ".lattice/learning/playbook-promotion-health.jsonl",
    "expectedOccurrences": 1,
    "contextSha256": "a4cea9c8464cb5c5aaacabd99c3bc4623d9fda6823fdc1d9892a8a09b81177af",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  },
  {
    "id": "capability-plan-historical-4",
    "class": "provenance_bytes",
    "path": "docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md",
    "token": ".lattice/learning/playbooks.json",
    "expectedOccurrences": 2,
    "contextSha256": "0b1b60a3034facf880693083bd13e4887d5d46e28a25068d1d03509311c7cee6",
    "reason": "Exact historical B-785e observation from 2026-07-05; not current runtime guidance or a read-side alias.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact historical observation and bounded context"
  }
]);
