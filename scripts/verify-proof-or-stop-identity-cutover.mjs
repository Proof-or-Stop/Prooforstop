#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
const POLICY_PATH = 'docs/requirements/decisions/proof-or-stop-identity-cutover.md';
const POLICY_COMMIT = '1dab23ae287fb9364244a3a73156f62f1abdb6e8';
const EXPECTED_PACKAGE_SCRIPT = 'node scripts/verify-proof-or-stop-identity-cutover.mjs';

const LEGACY_WORD = 'lattice';
const LEGACY_TITLE = 'Lattice';
const LEGACY_UPPER = 'LATTICE';
const RETIRED_ROLE_SUFFIXES = [
  'evaluator',
  'evaluator-cli',
  'implementer',
  'review-behavior',
  'review-channel',
  'review-concept',
  'review-delivery',
  'review-docs',
  'review-quality',
  'review-scope-plan',
  'review-story-init',
  'review-test-coverage',
  'review-topology-critic',
];
const RETIRED_ROLES = new Set(RETIRED_ROLE_SUFFIXES.map((suffix) => `${LEGACY_WORD}-${suffix}`));

const ALLOWED_CLASSES = new Set([
  'historical_story',
  'migration_input',
  'compatibility_fixture',
  'changelog',
  'signature_salt',
  'persisted_schema',
  'provenance_bytes',
]);

// Each signature row names one tracked source file and one exact literal. Repeated
// literals in different files intentionally have separate rows. The context digest
// is sha256(lines-containing-token joined by LF), so surrounding source drift at the
// exact occurrence is detected without pinning unrelated file bytes.
const EXACT_ALLOWLIST = [
  ['sig-review-guard-utils', 'packages/main/src/core/guard-utils.ts', 'lattice-review-integrity-v1', 1, '6d6337e99fcea8f0c8e4f74421ba083f83015e93df1a9cb1da4d3c7e0df0c9c6'],
  ['sig-review-machine', 'packages/main/src/core/machine.ts', 'lattice-review-integrity-v1', 2, 'afcb140cc0ecfeb73d3eec3e7d34e60a025aec501746c39690f48632a28077b8'],
  ['sig-review-process-fact', 'packages/main/src/core/process-fact-registry.ts', 'lattice-review-integrity-v1', 1, '7755f80706d60e5ec1f14dabc1e74f8979aca3708367ae06d818438c9fa465dc'],
  ['sig-review-reviewer-status', 'packages/main/src/core/reviewer-status.ts', 'lattice-review-integrity-v1', 1, 'd872012d4220cb0eeb491e80066d7936d4856a59cd2af9281af2ee73398715fc'],
  ['sig-review-story-review', 'packages/main/src/handlers/story-review.ts', 'lattice-review-integrity-v1', 1, '42926a79ada73d2844602cabcb344a1a9526ef1d5df07e91667d7429cbb7dfc6'],
  ['sig-review-parallel-smoke', 'packages/main/src/tasks/parallel-decomposition-gate-integration-smoke.ts', 'lattice-review-integrity-v1', 1, 'd872012d4220cb0eeb491e80066d7936d4856a59cd2af9281af2ee73398715fc'],
  ['sig-review-acceptance-smoke', 'packages/main/src/tasks/proofstory-acceptance-topology-gate-smoke.ts', 'lattice-review-integrity-v1', 2, 'cddbb362bcd31a1a90e90afd959e7475abfabb6ec224261807da14c8c2a7bd02'],
  ['sig-review-topology-smoke', 'packages/main/src/tasks/proofstory-topology-critic-smoke.ts', 'lattice-review-integrity-v1', 1, '8b3fba5ebdda35d87eb60af4adf5e36ad0dd7321e27a685bf997a5c63733a161'],
  ['sig-init-check', 'packages/main/src/core/init-check-gate.ts', 'lattice-init-check-integrity-v1', 1, '8af04d76437705a76ad3c88086e84622af24d6b587d976fe168a559b82f9de4e'],
  ['sig-delivery-check', 'packages/main/src/core/delivery-check-hash.ts', 'lattice-delivery-check-integrity-v1', 1, 'de68abe42b7ad17719a4b3e71b4c7892bcf47e4610b363105db908b80424d164'],
  ['sig-draft-check', 'packages/main/src/core/draft-check-hash.ts', 'lattice-draft-check-integrity-v1', 1, '828f4778734e9fedb5222680578dec3a289e20ea7e46c155bd22340de127ee79'],
  ['sig-finding', 'packages/main/src/core/finding-verify.ts', 'lattice-finding-integrity-v1', 1, 'cdea427baa39cd588ed0954af72a0a17b5e484b7bba2941e34c762740ec93283'],
  ['sig-review-pass', 'packages/main/src/core/finding-verify.ts', 'lattice-review-pass-integrity-v1', 1, '41857eb5a41e63e21a672323e9b654da685600462af93c7f1781a794a8f85794'],
  ['sig-review-run', 'packages/main/src/core/review-run.ts', 'lattice-review-run-integrity-v1', 1, '37ee1e168cc2664ccad091697d2f0372b0ea1a161833a5cf33364372ea507569'],
  ['sig-review-scope', 'packages/main/src/core/review-scope-binding.ts', 'lattice-review-scope-binding-v1', 1, '9d79b2dc570f61088269e62b1f4fe0e18b29fea9e0ac3862fe2e131c9f232388'],
  ['sig-review-workspace', 'packages/main/src/core/review-run.ts', 'lattice-review-run-workspace-binding-v1', 1, '175c931f50db2eca9dcb6db5a1500cd55bc2d2e81d1668f65121f3716576ad4e'],
  ['sig-scope-check', 'packages/main/src/handlers/scope-check.ts', 'lattice-scope-check-integrity-v1', 1, '023680419c231e5f9dc7afc214f132887ca20aa764da170204a54ee53db46425'],
  ['sig-closeout-write', 'packages/main/src/core/closeout-trust.ts', 'lattice-closeout-write-receipt-integrity-v3', 1, '2c77702b283338350c227087f17abf72d460d5d36038506d932151965d710670'],
  ['sig-final-host', 'packages/main/src/core/authority-contracts.ts', 'lattice-final-host-check-v1', 1, 'dfa2ab03a159b589bd136e66ed0adbbc170aea40c601dc10e49ed16231087976'],
  ['sig-stall-adjudication', 'packages/main/src/core/stall-adjudication.ts', 'lattice-stall-adjudication-integrity-v1', 1, '36de9e17ea22105b60ad69150e1e3e3959cbd727cd059500e47a094fa6c5bf2e'],
].map(([id, path, token, expectedOccurrences, contextSha256]) => ({
  id,
  class: 'signature_salt',
  path,
  token,
  expectedOccurrences,
  reason: 'Historical signatures bind this exact salt at this exact source occurrence.',
  disposition: 'frozen',
  contextSha256,
  verificationCommand: 'internal:verify-signature-source-occurrence',
  expectedVerification: 'PASS exact salt occurrence and context',
}));

const FROZEN_SALTS = [
  'lattice-review-integrity-v1',
  'lattice-init-check-integrity-v1',
  'lattice-delivery-check-integrity-v1',
  'lattice-draft-check-integrity-v1',
  'lattice-finding-integrity-v1',
  'lattice-review-pass-integrity-v1',
  'lattice-review-run-integrity-v1',
  'lattice-review-scope-binding-v1',
  'lattice-review-run-workspace-binding-v1',
  'lattice-scope-check-integrity-v1',
  'lattice-closeout-write-receipt-integrity-v3',
  'lattice-final-host-check-v1',
  'lattice-stall-adjudication-integrity-v1',
];

// Protected stories and fixtures are verified only by Git object identity here;
// this verifier never parses their contents. Provenance documents and the
// changelog additionally carry sha256 byte baselines.
const FROZEN_FILE_BASELINES = [
  {
    id: 'changelog-history', class: 'changelog', path: 'CHANGELOG.md',
    gitBlobOid: '9ad8fa442fda129d79b9124f18413b4172a63360',
    byteSha256: '6e1b350d86fcad1358d9cc518599bd74d661314b0fb6904087d0190da8b7a888',
    reason: 'Release history is immutable.',
  },
  {
    id: 'brand-rename-provenance', class: 'provenance_bytes', path: 'docs/requirements/decisions/brand-rename-mapping.md',
    gitBlobOid: 'd2abdc42c593040e9e51adb8a1fe64894e4da901',
    byteSha256: 'b1d68fcefee481229d3cca312a450922714ade947666817b34598ae202289154',
    reason: 'B-cdf6 is a superseded, hash-bound decision record.',
  },
  {
    id: 'identity-migration-provenance', class: 'provenance_bytes', path: 'docs/requirements/decisions/proof-or-stop-identity-migration.md',
    gitBlobOid: '25cc4f8c19b6589becaf508122530a33711c9d83',
    byteSha256: '29b3f32b9490e45b47c324edebe548e98f48acc1722096b62d84ab4eee66d040',
    reason: 'B-cc10 is a superseded, hash-bound decision record.',
  },
  {
    id: 'cutover-policy-provenance', class: 'provenance_bytes', path: POLICY_PATH,
    gitBlobOid: '58d0003d952a111cdf0345eee72eb12a6427b338',
    byteSha256: '61b3680f4df3917a0611cb847eb462459b08aed1c6d82e52a5525d02b3e972f8',
    reason: 'The approved clean-break policy must precede and remain unchanged through RED.',
  },
  {
    id: 'B-cdf6-red-evidence', class: 'historical_story', path: '.proof-or-stop/story/actives/B-cdf6/red-evidence.json',
    gitBlobOid: '44d101efa8b01a47d6252394dc274d195e89f02e',
    byteSha256: 'a2ce285110bf220d9e6f49c3c86e5a7b25a9a5f12807cc3aa7b2866db33a52c8',
    reason: 'Named pre-cutover RED evidence is protected history.',
  },
  {
    id: 'B-cc10-review-passes', class: 'historical_story', path: '.proof-or-stop/story/actives/B-cc10/review-passes.json',
    gitBlobOid: '2675264e0fe87c692202d6904f9c4c5781b22f55',
    byteSha256: '7abd1d56ae4263c3c7f196fa3548b721cf6aafcfdb474823470bba5d7f3b2395',
    reason: 'Named pre-cutover signed review provenance is protected history.',
  },
  {
    id: 'story-storage-migration-fixture', class: 'compatibility_fixture', path: 'packages/main/tests/fixtures/story-storage-migration.json',
    gitBlobOid: '925ae4ee64020f34b07faccb4cd540ceb2849eab',
    byteSha256: 'c9a8166165681b00e4ce16bf626bcd292beda25c2985eb389e35d77b60b50e33',
    reason: 'Exact migration fixture proves bounded legacy input handling.',
  },
];

// Generated once at the RED commit. Every row is one exact tracked file pinned by
// both Git blob identity and sha256. Runtime exclusion is by this exact path set;
// the protected root prefixes below validate completeness but grant no exemption.
const EXPERIMENT_PROVENANCE_ROWS = [
  ["experiments/baselines/lab-reviewer-history-v1.json", "032313efeaf8c570030b027470f1180303d6c0c3", "9dafb95e31e479bf5b367d4cabe1f8314290d2332ec760fa2da17289cffe3340"],
  ["experiments/baselines/lab-reviewer-reviewer-quality-v1.json", "ee76cbdb6d376dac71826418b99699f0f4c9d4fb", "41283f11bc15256f4459983e365529b3a6758431ef9bf29c5aad789242c00191"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-4c48-main-sync-readiness-result.json", "d0dc600a2109f5b458f8cf289707cc5dc1fe0e55", "3ecacbc51610e71670e813035846aa563fe32d3947f7b8e60809e229572664cc"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-73cf-validate-cost-timeout-result.json", "46ee8c4c1c930a930a93628afa0ae303e51a8a06", "8d3544764246273c3fc7a61c725f4dfe7657f004a10da3379294f22d3fd6f9f7"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-c356-proof-metadata-review-coverage-result.json", "c828743d7ea34affa470252586d71a1e472d8b6c", "0f9778bc6bca8d6ba2dd600eca1139b2a8bb2fcff1b76c91e8e5186b1f6030ac"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-d321-delivery-check-freshness-result.json", "69435bc1354cb70a80a0ae123fc8573711ce6a69", "2451f74513bc0170e595fb9b781a33d204b145c6ea40157b12412163b81243f3"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1-B-d43b-codex-adapter-gate-scope-result.json", "b2026504ef6cbdaa1598b736ff42928ae2b83c9f", "e49fcb8df837c85443507c602aba338192224949c6cf3d5054c1c7c1b022f70f"],
  ["experiments/baselines/lattice-workflow-efficiency-baseline-v1.json", "25ee2598b3d0074a625c9b3a3be35e6e6ebbf548", "a88b4e74cea33a0dc5ccef0ec484b7d8a4006f70767ffd39eebf0b179f5fea52"],
  ["experiments/recovery-runner/README.md", "3176fe655fc989b36c20b4c48e0253710a294a81", "105f5c381f0d26daf72e64e50fae1a98f69f3f13e06e1cc85ccef2d90fa91ce8"],
  ["experiments/recovery-runner/a4b-pilot.jsonl", "f14074c71e592fd8b1bff6e3000f2e1dc7a979d9", "1ce8da74582abb2b7c90be78d6e90b31f8cd7b5a0e51317703cfb6d1933a7d52"],
  ["experiments/recovery-runner/ablation-A1-prompt-only.jsonl", "446b4f33212f74d183ed352e435fe23e423edf02", "35ef9ae637bea5710be9cce2b799deb88ab724866f46a45328550a3167860be6"],
  ["experiments/recovery-runner/ablation-A2-naive-retry.jsonl", "3e2e93dd13d86fec373aed9ba669373e39d88b05", "2862dc4fc9d86defc11694937d256bc9494b386b2d834cf50ed970b3780c968e"],
  ["experiments/recovery-runner/ablation-A3-review-only.jsonl", "d2ea9795b99ef292f312721ff50f64075e30e3d8", "4c341ffba66641bb9c79c81d9e895b065e042a90528f0800b4b4fdab9aece75e"],
  ["experiments/recovery-runner/ablation-A4-lattice-loop.jsonl", "acb9d730677139198e7c9d83b149d6ab495769a5", "3be3ea191800109d64ad1fb54b195a9f48c14651b85578fac131fe978d135d27"],
  ["experiments/recovery-runner/adjudicate-selfcheck.mjs", "7d76a22dcc1f9658f1a3242f2e6c068999d4e931", "cb71b2dbfe11a380063a2eba86a42cb8945e1fa032059735d755ae236cc7e531"],
  ["experiments/recovery-runner/adjudicate.mjs", "87124249dfe8b273649c8e951c8d860fc4acf447", "a72fa4a06244245fb8f1af33f2b15c907723c96daacba7113cb00235942a5a87"],
  ["experiments/recovery-runner/analyze-selfcheck.mjs", "b31157880689d24943890aecb4ac0c179e40b663", "cafb016ac4773eb6c8b038f8fff8c6f109f9b08036bd18c5db8f33bb4a7e5dde"],
  ["experiments/recovery-runner/analyze.mjs", "663a7d5f65e3919dcb99bb150599be990518cccd", "b65a3c484df4984d026074e79eb28a7ebd75c9cb6a2b90ad86186fedfffa87dd"],
  ["experiments/recovery-runner/baseline.jsonl", "22a1a6ff40dcb91fc9e271685522ef4f602c67aa", "c1238709a6437fc1d026e04f9d99f300a233a227375a433e798e2e1244155c91"],
  ["experiments/recovery-runner/checks-selfcheck.mjs", "ddb564be0fd3d677f6c2ee1e34f7322ea806e8d3", "e894c195a14121cd8c72ebac4560a3bd9d070eeb4f99c10896add755f860b288"],
  ["experiments/recovery-runner/checks.mjs", "b85d50c48b420ad4fdc532a0bba48866745c27a1", "c773f21f99c3abcce6433815e429873df08eb57f92b8f96732eae1ed0063e751"],
  ["experiments/recovery-runner/corpus-selfcheck.mjs", "fddda303e27f9cea7574743afe1a5ba03a0486ba", "7f892ebfca3444ecc120e000aaaf616658417df55f204b98cbf8d3433ff5827b"],
  ["experiments/recovery-runner/eval-expr-pilot.jsonl", "47746b6235652d321554f2f11ab71a31bde1fdbd", "05c5d496dc12a379e5d72d5e7626186a67060924dbb0de27b960496f5c4fc1c8"],
  ["experiments/recovery-runner/injections/corrupt-output.mjs", "5d42ff87fc0dc42cfcf377116f7810e3768f217c", "8ceaf8aebe1515d160d0ea6a18bd999cf96093bfb297aee8020b12b45758f334"],
  ["experiments/recovery-runner/injections/delete-output.mjs", "b70899b11498ed41d21b745cfaed2d348a039d92", "b6064e72eeec47ade9c59da6af4685b6581c2404970a4673a38b8578cc672eb0"],
  ["experiments/recovery-runner/live-engine-selfcheck.mjs", "e0fe8fee79a960d4157429807e415fac8ac43374", "737fe6beb7a1f778abe09130b2a9f9ae5c0fc79bb157edb5b66865c83bb6a3c1"],
  ["experiments/recovery-runner/live-engine.mjs", "3fabf5705edfc3e0bf49f420c4cf8968cf21ce1d", "5058585c459f3c5a75a55aa8e8b3130c123915d53ec0438f5d62e67ebd6f9a9f"],
  ["experiments/recovery-runner/make-fig-gate-ablation-selfcheck.mjs", "19e86692753da676c8bb84c26c5c790680da45dc", "f360a8fef674a921ea47450568ae0eeeee5152fb6fb123e84701e93dc7365f89"],
  ["experiments/recovery-runner/make-fig-gate-ablation.mjs", "86e0a7ffb5b9d2b348bdcf60735844b4b599e44c", "95af5004d764ebd82a7ea92ae9db8f36db3699e9e569ad2b9f19169cb5404ed7"],
  ["experiments/recovery-runner/median-pilot.jsonl", "1ab6454e4b11d084a6862c02a8d7acfb76c53018", "76fde45ef7747e4375a0bb9cbbf43989b9cf5517129214305bee4b1d1dbe4194"],
  ["experiments/recovery-runner/overfit-pilot.jsonl", "941335d291d9752337827800a8b03da867adfeeb", "77c8224b06f0eae0429831f5d45cb098e563282a95095175d51190f3a73cca7d"],
  ["experiments/recovery-runner/parameterized-fault-profile.mjs", "d38d15fbc0e730d211a95347101cfef64e18bf7a", "526ee2321fc958dfd92f1d52ba57f73b022af789046d2a1fcbf460a4529d6c01"],
  ["experiments/recovery-runner/pilot-records.jsonl", "04f78905a5962f5b316d8fc06d492bc256c634f0", "766f92d372f5121d8262276ed9ecaac57c116739185101c6bc41f445338f8846"],
  ["experiments/recovery-runner/recovery-run-records.jsonl", "b1270fc8f6ecb05589f3acc28a651433794f13a2", "6d6a22084d20e3d235ad0e648241f5b410e3b5d58208459cc26bdb4f2ba6c340"],
  ["experiments/recovery-runner/run-a2prime.mjs", "a924f53ca7a9ed53417f045ba4ca0f43cb773c6a", "e93da75284abf94244f18a41bfebf00347cc1a1ebed40614e5241d105726ca21"],
  ["experiments/recovery-runner/run-ablation.mjs", "16ac5b5d953e974f79b5a8a21a3f453e153e76cd", "f2a936b3d41812591355b1f8703a8cc5011e710f0126814ce3c106d5edf1ca74"],
  ["experiments/recovery-runner/run-driver-selfcheck.mjs", "68b977b703b1c7d57af0b46fd00c201753ea4a89", "a36c636aef22c3d107f670e58946039226b5694f3e0e85f3e2e049d749ccc431"],
  ["experiments/recovery-runner/run-driver.mjs", "b186cc5783ca75848181960a5f8bff3e508f6e87", "f95b5ce46e29e0e462b144a78cb87145bc1e9ca7cbb649db5c24efb298392227"],
  ["experiments/recovery-runner/run-recovery.mjs", "f90bcf833ba90530601586ed3c71433a81c436f9", "1d1deb6aa2ed0eb8b3c9ac3c0af63e8f6d41a899ad9bf045536f36c1dfdbf46f"],
  ["experiments/recovery-runner/run-selfchecks.mjs", "c3ad97926dcbf321ea9feca738dc95207861e8eb", "a44dbd9a5dad11f60b74334432bd5e26c26fdccebc62a9009951b4f1f4f4ec86"],
  ["experiments/recovery-runner/shipcontrol.jsonl", "c1f172eb7b097a97a140c21af866b68595db7f74", "67e5ff6daa8f87d9aee60606fb97c788aacc0d25eea5f1375cab6b945aea2b7b"],
  ["experiments/recovery-runner/spend-accounting-selfcheck.mjs", "1a6854450026b1471579d939dd1924ba79d0c196", "dcc79922e54ea05c49bbb408c1528d645b5e5f6eddeffee0793620b032d842e5"],
  ["experiments/recovery-runner/subtle-pilot.jsonl", "abdf8472fb32fcfbdf47cc472fd8b87d14d2605f", "657d291d507c977b3ffae57fde2a7794d05f7e44f3efb21fbd62aa43f9bf7cd8"],
  ["experiments/recovery-runner/tasks/bf-datediff/acceptance.mjs", "3fe1262af7f3ea036f6df4f105984f508000ddaa", "2f1ddbf0d6b945f695622f5a9cdae99a495db06097e1043254c8fe80566f350d"],
  ["experiments/recovery-runner/tasks/bf-datediff/ground-truth.mjs", "921ec445a49b8a669007c80c7410e4614ffbb737", "9fdf05b4334bb20cb81aa4becb7719f0ab2008538cb6611d356717a0528f4b90"],
  ["experiments/recovery-runner/tasks/bf-datediff/payload-subtle.mjs", "99fd4e600a34c46b8b71249a7136e8722d29bccc", "6a9575bfe40dd17c757fa5c9623be1f3d2145985a5eede0f4b04c1bbdbf2c7f9"],
  ["experiments/recovery-runner/tasks/bf-datediff/prompt.md", "9cf7f65fd3a8caea95c3ffc1fa7820281f4ccc3e", "3e6de09017734ff96c6dd5140c70144cde14e610a7ee2cf336139d7dcbe7e9be"],
  ["experiments/recovery-runner/tasks/bf-datediff/reference-solution.mjs", "ce989eee941895146291dc83ad4a85882ebbe841", "f659246737a8e8d4822e53f70d95b3ab30e6adf8f8a19616affd377ec09dc8ca"],
  ["experiments/recovery-runner/tasks/bf-datediff/subtle-wrong-output.mjs", "dfc4780845026393cd87ab4c4fbced64e8a5b581", "2ec897d8c731ea4b8736f0f9692abb50f6445f616f3a84c360652333d057f1e0"],
  ["experiments/recovery-runner/tasks/bf-datediff/task.json", "52a1de50dbabddde11be55a744701dcc347d307b", "359addcfa01e6938bc95cd8163b4f87d50159b0a2285f3e7f04832190bf31f2d"],
  ["experiments/recovery-runner/tasks/bf-lru/acceptance.mjs", "63f86de2429e9209c93c0343da289f084c22440c", "0df057b45d4932d3e4326f08be17ca42bb22325fccd4d48772305e32adff7f2e"],
  ["experiments/recovery-runner/tasks/bf-lru/ground-truth.mjs", "9081a651f1ffd4105b21c46edaa4a4c5140a3a47", "02ea40e8eba77d45a13c010291202e0a91f988c845b52e8f00ec8a7d515ba476"],
  ["experiments/recovery-runner/tasks/bf-lru/payload-subtle.mjs", "83d623e3c01e5f89bb801f054c416af1d72a75b7", "84c6c0dd89d24035d1e60a0334754388a9d8ed56d059bbf30c7d5168f7403e9f"],
  ["experiments/recovery-runner/tasks/bf-lru/prompt.md", "f7475c4dd177a497fdd4a82e2388a07e99a1eb66", "f44a339416ed993382e5b87cc6f6f0f707965f3747ab4d8c89f7ce7c41204608"],
  ["experiments/recovery-runner/tasks/bf-lru/reference-solution.mjs", "2efb1c1dec5f5f13a4d18399644640b7a0ea27cf", "adb77e7e45d655f852e4adc24c592cea62226cb1718289ad8c3a7599e96b1846"],
  ["experiments/recovery-runner/tasks/bf-lru/subtle-wrong-output.mjs", "fe27fe4fcb233db6816d45f8889f0504b14f8671", "ce557c766b972cef5bcaef3837e8402a620fb1a14ce45249b2db3ad83cbb65db"],
  ["experiments/recovery-runner/tasks/bf-lru/task.json", "385257332505d77a5fcf7725d51db2e54f3f866d", "ee1b0029e14da63cb21c2ece16fea0c46fe3993c00bb8190d7a0a5d4c2558867"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/acceptance.mjs", "9b3ba2ded607842566b1ab290b5a434a3a521752", "ddde2a247550d707c9216cb4d091fb7c381907e2cac2add04655d197cd6289e5"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/ground-truth.mjs", "00c5e053596d7a23691c9675d02cd1d2b90030c2", "64783409ff81bae6909fb95be4b312c75c73567ca61048d137e8b9def349309e"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/payload-subtle.mjs", "59ddeaae9ca466e66c0fb994e6936e3527e8d4df", "08842ffa4757efb470122f5230ee913297dd1c01a2a052e91e6e4ed115c46038"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/prompt.md", "16dbad41bfcd7b2aad216f3b4fef25a7f1fe1d42", "65f6706280b325f3ea6f74ab426cf2bcd96cd4b8b8800f16af7d18689e220984"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/reference-solution.mjs", "001910055d509b0522a9b560c9c68d6fd27ae9e1", "64dfe9a4da29b9a03cb6b67c5d1278caa7bc42a00f6e95ecc4feee26625d4c9e"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/subtle-wrong-output.mjs", "7d8b24190658a14dc20aa96e78f653f4a98a6745", "3cb8fec09710f107673dbb4d74246b83928e05ab2380d58affa8d1ebab22ae9c"],
  ["experiments/recovery-runner/tasks/bf-mergesorted/task.json", "d3d5918f2c30819048a4ab2395323783eb70e17a", "2da53eb9ed537529730d2b40cbf761b69197e81118955bc8d412becb2028cc84"],
  ["experiments/recovery-runner/tasks/cl-combined/acceptance.mjs", "6e7315903ea596ec0014fbf963e3f360aa28a3c0", "5a789055e152c9a61c2d48017fb9146311caa341ba25510332ba3f7cdd608c72"],
  ["experiments/recovery-runner/tasks/cl-combined/ground-truth.mjs", "49863077e1c82a6a9e92f6872ee6784cc5f06c13", "93a01f6e2ceb8477ca6e49fe5bf73d9c0eb105ff8bcb22c81332492c4f58c08e"],
  ["experiments/recovery-runner/tasks/cl-combined/payload-subtle.mjs", "75c721278ab7c9809366ca8f79619d7324f5f7da", "15f77ef9e5d68d888814ec860d4a1507076d2fec67350528065c8086953672e4"],
  ["experiments/recovery-runner/tasks/cl-combined/prompt.md", "02aabaad5be0f4752f366f1430813a9d45cf0822", "3074e095fe70c06053d9196e6a81fc1d73d340bfaf635257f580e2a37d7158d3"],
  ["experiments/recovery-runner/tasks/cl-combined/reference-solution.mjs", "8fb0ea8f18b3df12e0257f59497ffc762c2bc955", "6751437ec140e857aba8934681aad4237197fd3a0a1a7b744ace38037a0f0dcc"],
  ["experiments/recovery-runner/tasks/cl-combined/subtle-wrong-output.mjs", "6e1a64378e2940030e06b0f06fc4bf161fa34cdf", "a68ebdfb9ed00ba9c7058f8c2e252e1db5ef12f2115f04a6c789bdc8d090b7fb"],
  ["experiments/recovery-runner/tasks/cl-combined/task.json", "c16acc38255f1ee00890ff8db44310c53a936bcb", "3f507c7d0b2a8a8a44c41d11043c9f4672f46b01fb17336d671a91ee1122927e"],
  ["experiments/recovery-runner/tasks/cl-equals/acceptance.mjs", "0c1feb5673ecdc3e6291c8cfefae931696923569", "45e5e2640587f7e1ec54ccf5aca024d436357d04ffa6a607bfeb53b88cac218d"],
  ["experiments/recovery-runner/tasks/cl-equals/ground-truth.mjs", "fb2c4ceffb0b38ad66b518d024a60cb88bd314ea", "294dbeb50035449d0a1369044e189cf4b06e51c967b9a03c291ab57fa8475fec"],
  ["experiments/recovery-runner/tasks/cl-equals/payload-subtle.mjs", "413300df6ffdd68647ead7ac6e15da60655fc49b", "85f59e63c4fdcc49dd219e5b3445006248791a563830147d70e3a639e8aa11cd"],
  ["experiments/recovery-runner/tasks/cl-equals/prompt.md", "8c3bd77ebeea9e059bd347247644e2f0e78072e4", "9b1f221f1f12e4da14f2149911226ffaaabc7765b4813f63d549fe9925582296"],
  ["experiments/recovery-runner/tasks/cl-equals/reference-solution.mjs", "b8c6cc9ad8c8cfd48dbfd664a3315819088dad5d", "d2d380f44b0869da58ab3fedbeebca909faad2b760b5a54c69b410e789298f4d"],
  ["experiments/recovery-runner/tasks/cl-equals/subtle-wrong-output.mjs", "1416261f95bce0906b1992ab8da43561e7ffaf67", "98b803ae0e0b0f393f73ecec91990a0921e4bff1120cf37624b415b8b30a44bc"],
  ["experiments/recovery-runner/tasks/cl-equals/task.json", "fac484307590eda94e6cea4884a743ecbafbea42", "4a200625d51338d1b09f0c6eddcd60ba46b531e42bef4a6fd214dbbb2989f849"],
  ["experiments/recovery-runner/tasks/cl-multi/acceptance.mjs", "b92540b851154c792f5ea67895109d83596d1af5", "dd2aec10d1d7cdc4824bf011deec2aa23c5e87eeca99511cce51e9f3228d9476"],
  ["experiments/recovery-runner/tasks/cl-multi/ground-truth.mjs", "304f528ca3e6830dc7b4f4e6cfcbff86e5b70ce4", "0d4d31e634520ebb345d75fbed9c04d41d99c28825f384e49b0a2e1509d37264"],
  ["experiments/recovery-runner/tasks/cl-multi/payload-subtle.mjs", "7515221b8480e2b838f7f797ba9ea0f7202a506a", "bc9eb58562a76140742ee62998f3b2e7b10f32163edaf3818c48ca8781600394"],
  ["experiments/recovery-runner/tasks/cl-multi/prompt.md", "3050be9f2f3ac1f0c15afe42d9972a0c82e087e1", "381ffd50c6b70863f8fa8c6c589712702ce8f3e6f91d28a5f3eb071947588963"],
  ["experiments/recovery-runner/tasks/cl-multi/reference-solution.mjs", "ca9afa26d90833d5cb05dab56bdf693b40673cb7", "2c10ddeb3483ad4f902b5b8e5910e648e4fd0b51afca91bc0081430c90b4acd3"],
  ["experiments/recovery-runner/tasks/cl-multi/subtle-wrong-output.mjs", "55bc09163e2579441a196bf6a4037e08f19ae8de", "dd47468e523441411d86d84423a4caa6e6547d3b782494e169c5069bd6d06aad"],
  ["experiments/recovery-runner/tasks/cl-multi/task.json", "1f7c19ab1bcda5de2f072c398d8ea3ad5d881d8b", "dd925c3ee3485644e63a2c940b111fe043015aefc664659c80a2a156b644c3ad"],
  ["experiments/recovery-runner/tasks/cv-email/acceptance.mjs", "8904c6f9faa1a3a7467282a3e83ee3e2ad78bbdd", "527573cb37a969c5ed21eee12221586ba7c2d6aa2c2295888c41bafb81ff0028"],
  ["experiments/recovery-runner/tasks/cv-email/ground-truth.mjs", "6b2ab1ca393a4840af015958221c271d458e2dcd", "5692cac6b27c13c4cb74fc01369add92af5a2be0c7323083939782b5b44a6d46"],
  ["experiments/recovery-runner/tasks/cv-email/payload-subtle.mjs", "2b1dc99dbadefab2bff6ad20cfbd3c882b697d30", "9f72ff5e9a02115f5e38d17ebb7134a0378e0ebd84791179e61125ed8d5b5517"],
  ["experiments/recovery-runner/tasks/cv-email/prompt.md", "cbc8c06808cb978f93d254b3e81239a7d4c03094", "f9574e0f5214cdfb91f9b9e6eb0c23aac85726283ef647d149e22e1fd703f82c"],
  ["experiments/recovery-runner/tasks/cv-email/reference-solution.mjs", "af5666dda376f0905425c9da6d6327c33edc19c6", "dc8a42f04eb9916c5c9d4ccf116768f428a1f27206bb4585e2adc9788df5d55b"],
  ["experiments/recovery-runner/tasks/cv-email/subtle-wrong-output.mjs", "442eb9c4fd3a292a77b299f53ed25bbbd373f268", "125c067c1bb5e5857a005638336ca1221e4aa5ea6bdec9ad744e76f023e99f31"],
  ["experiments/recovery-runner/tasks/cv-email/task.json", "b3a1126fe08ac11152d91245d64f2b7e1567196d", "eccadf3348a8bec6fc6ffad121dd60e4725caacf7e9a795758a68cbde58c3f33"],
  ["experiments/recovery-runner/tasks/cv-ipv4/acceptance.mjs", "c415b1418a6449d9e70a23aab9aa54902dc62331", "983e1d36197ebffedc00f08b0c4b0562fa80a1d71a31a09d00eb10c0bba8d101"],
  ["experiments/recovery-runner/tasks/cv-ipv4/ground-truth.mjs", "c621fc41a0cf65e989c5b747d2c43ba76faa006b", "7bbfc58b1adf0fec42b52a9190ba4721d5710a93e3cb9f46e484e539f6137647"],
  ["experiments/recovery-runner/tasks/cv-ipv4/payload-subtle.mjs", "48597a07ad93f516bf8d2e1769e7e727f502d489", "e72c8fad198679062486f5f6cbba0d841f7d2b9baa1e5bbf587edf72569341a0"],
  ["experiments/recovery-runner/tasks/cv-ipv4/prompt.md", "288f350384dabc9e17e7f9f7667cefe478237bbb", "588afe501ff184f3a0162b8f9c2a530cd6b4dfbf0a792cb8f42c09e62e5764d0"],
  ["experiments/recovery-runner/tasks/cv-ipv4/reference-solution.mjs", "5ffd1777f6d7c689932f34e8b512212fc300261d", "887d33b5e1fba132942c21650ad6aa7c98841cdf845abd2c6d562c27de30b990"],
  ["experiments/recovery-runner/tasks/cv-ipv4/subtle-wrong-output.mjs", "f94890a5884e435d2ff519e84466eecd20fb7ca0", "8a045b9e0b4db6da06110891c389328219bf9cb6dab264a2e298126f98df520f"],
  ["experiments/recovery-runner/tasks/cv-ipv4/task.json", "352181aa9a43ecb2f690654ba7be966b2d6796d1", "17a0f181bfae5fce38b6192b204a7cd68a09f53f3a1eb59810a5b788d2579bf9"],
  ["experiments/recovery-runner/tasks/cv-luhn/acceptance.mjs", "7035ee905bb5696ce7be5d917347fb2d4d4253e9", "ca3bd22ad9c100a0b511c856288eaeb3dd4e9e36d99b87475f66a6b7d67a8a8e"],
  ["experiments/recovery-runner/tasks/cv-luhn/ground-truth.mjs", "a53c318cd7579b5468380378ebe858698acb1871", "43029ce462cdee76e3473173fb17319be4b99a30a4988da2632e67ddc7bdebff"],
  ["experiments/recovery-runner/tasks/cv-luhn/payload-subtle.mjs", "8f40e3af7e139a80f8aaad280fe8cbc342ce883a", "9ea23d49508ff82b7b5689880c6cf32cdf4f739a9c50fcdea8ebe181da389f94"],
  ["experiments/recovery-runner/tasks/cv-luhn/prompt.md", "312cb3aa6a6a9dff885628f1efbb1e15d4cdb14b", "4ebd1b3e5e20ee6946f51da55362ab025862d0840221bebb5cf04261ca34d4c7"],
  ["experiments/recovery-runner/tasks/cv-luhn/reference-solution.mjs", "0c776a868493b3d3887caafe0f357d8d89329167", "fea7bcd43c8d2bd7f1cf6b38bf4fe7fb4df3f810bb16c418d68759434c9be669"],
  ["experiments/recovery-runner/tasks/cv-luhn/subtle-wrong-output.mjs", "f4d302c8e1d8744c2a7fe5693a07d78937daf6e4", "111d7e23a7a4fbc0b95d1575b93195e8c91b9b95107731f2bb74829d0f00973d"],
  ["experiments/recovery-runner/tasks/cv-luhn/task.json", "26a75ce87f2c495ec14f874b98629cba1455063c", "8a35753c7ae7b26ee7805f0ecac607114158a36346fa0b453a8d1abacc43d28d"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/acceptance.mjs", "4ad8d0a7d8e0fded745fc585ba27091b4a1d4dd3", "153ed937041c13879b86adbafcbfdac4ad2287094a2b67d2840cb1fd968bdf24"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/ground-truth.mjs", "dc79642ab334dfd8fcb95b95dff9207629069416", "7e92d53c1f95c5d896b36fc109e3b9ef6200223b3ed8682b5aaa740fa40e4128"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/payload-subtle.mjs", "a16843595ceb0fbdd23258a1777d9bf92d574db7", "fcb68071bc6fc2a6677fe31af741c644fcfc441e5c0911995e3610ee825ebdcd"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/prompt.md", "9dd81c312d7dfb0f4c9787ba2ce10ae52e82c2f7", "d9d062d5c662745530b0fc802444f27a6c8f98b9041a6514036ffb7986fc2a5d"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/reference-solution.mjs", "c847229499c8b7fe945c080565f7fdf8ae9df6e6", "ec1171376d6559af61af3e0e7d878d5fdf671ed927972013e8b1555aae90abcf"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/subtle-wrong-output.mjs", "e1e1f1c0dfc1f675c376bd2d6b9b8afa42762f63", "69f9bcc14336fe4721e57f2ffc39719f88c640e3c2e6ff51d0a71e4e3d86b4bc"],
  ["experiments/recovery-runner/tasks/dp-deepmerge/task.json", "c3153df749e967265f1c51706355feceaa2b7341", "2cdda0fd028f0fad98c9b7aaabde825b3e579a66f19d9000967b52e84cb4d24b"],
  ["experiments/recovery-runner/tasks/dp-querystring/acceptance.mjs", "0f3b45d9508d3432f0bacba478e6c56505000f4d", "3e56580735d583a55f614cb7cbac1b05878dfdf276848a0f959620768c8cfcf5"],
  ["experiments/recovery-runner/tasks/dp-querystring/ground-truth.mjs", "5c94929c9e8e27c35eedf8e750497212ab78a6fd", "4229f842ab639823da1542bd01d020c909d8f037f5fcb49225e1fe44a39c9780"],
  ["experiments/recovery-runner/tasks/dp-querystring/payload-subtle.mjs", "0bf4988ff963ebcd4a0a0925898b6f652c8795d6", "65877c0397e5b0c76f2195131198641c6a98102f910b5ac2ddb1d03a21044ffd"],
  ["experiments/recovery-runner/tasks/dp-querystring/prompt.md", "3de5ebfe6b619732b6f34e926bb85f1bf1d5fccc", "7dc3f6febfe91425949860a70035a095e7676d25678ce117137ab2fd8e235bc4"],
  ["experiments/recovery-runner/tasks/dp-querystring/reference-solution.mjs", "995d82fadc7b6b68b0c049055823c1503870b819", "98ec97433e66dced65747e16ff5427ea02989400b6e48cf096acad0efddaf8d9"],
  ["experiments/recovery-runner/tasks/dp-querystring/subtle-wrong-output.mjs", "72e59dd410fbbd62af1677a485c83fab28ace03b", "2674a7585d363956a80176b6e868e1a66993718622991095400dec4b2fb99613"],
  ["experiments/recovery-runner/tasks/dp-querystring/task.json", "6182f9f370bbccb87966c41ccec4c7b33271ed7f", "48121299645006d082bf70d8760c18bad6c1c7d4c9bfc6394854780d73bc1ac8"],
  ["experiments/recovery-runner/tasks/dp-semver/acceptance.mjs", "5676051a26d4ec7375d03b3f2b6da89058687e76", "d79fc6533a28666d37aab1c0a9fff1f5a562eaea062bdf674577740dd44d7839"],
  ["experiments/recovery-runner/tasks/dp-semver/ground-truth.mjs", "d8001e932e06e5963d1edc68ba70333b3d08c7d3", "45a67cf29536fc422572a84746061196dc440fc0f61450b0b4e4429b14ecc428"],
  ["experiments/recovery-runner/tasks/dp-semver/payload-subtle.mjs", "ebdba771605b4808019cebbe0cac144ebca13e95", "1606910da857604039e5bf1cde5d2e036b9202448dfd157bd6a07c554da72d20"],
  ["experiments/recovery-runner/tasks/dp-semver/prompt.md", "31e13d74ee355f59e1455b529faf2b39e344a3f5", "5501572dc2b13707a619d292e671564f6e23a7c7f6775af3d95b6202023dc14e"],
  ["experiments/recovery-runner/tasks/dp-semver/reference-solution.mjs", "b936141583b8721d0b20a88d9ce73aa0f689a5fa", "baef261922e870c45c19e6fff09757f6a467774627a80518f17b6a2407ecf990"],
  ["experiments/recovery-runner/tasks/dp-semver/subtle-wrong-output.mjs", "b0ba347227376290188d64928be47af4cc55a910", "e238b34e7104ecc2d9394ddc9aa6571a5c795e067a94377150f2fe0e0860fdfa"],
  ["experiments/recovery-runner/tasks/dp-semver/task.json", "dea76d366fbdada11f2d88945698e28bfc73e346", "9fcdd1569d1542b202e93eee19e6092dea9ceb0a2545106526dae4001a65a8da"],
  ["experiments/recovery-runner/tasks/du-duration/acceptance.mjs", "6ad34023358c64e8bcb5450075e9596a40a14fa2", "91753567096e84c53da86ea9a39631a8848f08a35060cb5efbc21f33895381a4"],
  ["experiments/recovery-runner/tasks/du-duration/ground-truth.mjs", "d1a8216b86e3e4e9559694a491332af6f9b97e3f", "bf6169b084ad6e2296d572923dcba506322ac5a34062b7658eb6476e34053f27"],
  ["experiments/recovery-runner/tasks/du-duration/payload-subtle.mjs", "dcfcc7dab0be3f7480049316da2755fc68569588", "416e3e8ee5e9c7763ebf1fea9531a6df7df5e8a9e3f023b46508dd3f36171075"],
  ["experiments/recovery-runner/tasks/du-duration/prompt.md", "358fcdf57e5f0c26731d6b74a486ac74cf10b656", "ba26b102831f1d3eaa19904a4726812bc3d8988a9d7cdef388a66926cec32a86"],
  ["experiments/recovery-runner/tasks/du-duration/reference-solution.mjs", "4b932b1354fe7c5a20e852c913320a47253ba777", "30c11644b67e961bc7ac33e85a70d6cf9b1889e7b0a53063e217b6fc3a0817bf"],
  ["experiments/recovery-runner/tasks/du-duration/subtle-wrong-output.mjs", "ad3afe1cf2f45a1897a26a402de1753155a61b7b", "9fa3b20cacbcc2291e191f5451d7364f7391ba4a54b0257943e8d82f328f6f4d"],
  ["experiments/recovery-runner/tasks/du-duration/task.json", "8b2c8536566b34faa3e3e01e8d1df21326b70c79", "85a17fa8d22fda4eb16b676fa078c60f65012f2f73d9672fee93ed22c991a30e"],
  ["experiments/recovery-runner/tasks/du-interp/acceptance.mjs", "36924b2be10b6825566495ab7b1b5cc1f3417281", "758f663e1c8e08a9d1c8070b78702f9e518c6af1657613f9e44ec67c86c6a39c"],
  ["experiments/recovery-runner/tasks/du-interp/ground-truth.mjs", "80c2101b556bdbf2359da49d5beb44fc20afa3ad", "cb1f4427b3eb27513665d292a3a68080ef3bd4f773cc55a49fd87e2b8f717ddd"],
  ["experiments/recovery-runner/tasks/du-interp/payload-subtle.mjs", "44d39f86d27183cb9042844c4d17fd53c80619cc", "83d4211c51f4c57575d440c556f9bded1fa86070ad98cd381b881779a49f3643"],
  ["experiments/recovery-runner/tasks/du-interp/prompt.md", "988f17e9acaceab776d0cd6d1c2f9bca2373ea68", "4a1b98977d03a79461030b1eebc91d7e40b4ca61826fedf625d52d64a5cc9efc"],
  ["experiments/recovery-runner/tasks/du-interp/reference-solution.mjs", "07aaef4fe5a9ce45d3d470ea4b094d04281d2c4e", "1fcce2fac7fb7b231661fa05f0113a343608b2093a136f6c918dd679af8886e7"],
  ["experiments/recovery-runner/tasks/du-interp/subtle-wrong-output.mjs", "42694bcca5a52c30e5048df790359dac803bb1a4", "a6bca97ef2ef93f5e5d05725176c6fdc2b3d866ffa0463343e0edfa834635b8c"],
  ["experiments/recovery-runner/tasks/du-interp/task.json", "715d7ff35e31094ab40727178ebfac6318b8a04f", "7ba16a5c93024b1742ed294f642efe0720a55b26840bd41e93af09081f29a5de"],
  ["experiments/recovery-runner/tasks/eval-expr/acceptance.mjs", "2781b1a98071f30abe7bbebcb647696f6c8b774c", "b4c8024f13b4dabcdf94af45b7f1e4ba426d26d36dfefd234dec6bb969cada42"],
  ["experiments/recovery-runner/tasks/eval-expr/ground-truth.mjs", "810cb1494f1a81511a2ad1203005315197d3a835", "91f03c984d65bf33f2446493646b4645bae8d02af41fe47d9e59da8a49c2e2ef"],
  ["experiments/recovery-runner/tasks/eval-expr/payload-subtle.mjs", "29f1397980f2b58a6b5af4128c7b40bc451b79b8", "20aef705e003c260dbeadc81a53c0d25be80946dd25e4003b256872b92281cf1"],
  ["experiments/recovery-runner/tasks/eval-expr/prompt.md", "5382fc88e51f7fb81a62b21bac971243798d4c44", "53e474369f114c1e6b040dd8c3f29c8272aa3c5fec7b0d5ccd2a2e63f6a637ea"],
  ["experiments/recovery-runner/tasks/eval-expr/reference-solution.mjs", "d83386eb7d1a133411134a08e9a2f3fb23750dc5", "67f2ee6d8cfeb86fc48985cdce0b0af9c294fe1a92caa94b0239984cac0c56ed"],
  ["experiments/recovery-runner/tasks/eval-expr/subtle-wrong-output.mjs", "42fd4107b745b8d0be02011ac2709a0afed77c25", "5efb4cfe84ec4810982c5e951d7a360e2fc33d6717d8e87e85a367cb9f53eb24"],
  ["experiments/recovery-runner/tasks/eval-expr/task.json", "42768bc1b2d24f9523b21195ce958749b4e4f170", "f4487135ebc5dee0c7cc073671dea894989c14a2c8e13749da646ea0c8bb2f7e"],
  ["experiments/recovery-runner/tasks/median/acceptance.mjs", "4b8869bea67e70881267ea7a94de5aa1880f8353", "2772932241cda1833eda2cfce962a334d6026e632d41ea7fd2adb8067f0c2d21"],
  ["experiments/recovery-runner/tasks/median/ground-truth.mjs", "e94a12aab75ba47b0024bf302fab4a50c32bdc29", "535be6d25db2f4aaba11b8d4aaeb926a866ea6f7a88981dd29a10dd6b70613e3"],
  ["experiments/recovery-runner/tasks/median/overfit-output.mjs", "31e741c58248f168c5f399c5863bcd481117987d", "f7f11c8c036c431ec931dbbfa359b99ae9d60517b8653498b81ea7155f4d1938"],
  ["experiments/recovery-runner/tasks/median/prompt.md", "df0c2b32b4496f1f971a3ebf3524c37678b3f4a2", "d606ee27913cc8e39e6b8165d41f602d0d2b5d2bd2a93be0b286ada3f1be450b"],
  ["experiments/recovery-runner/tasks/median/reference-solution.mjs", "c1ff54eb83ee331203afee4251eec3125939f15a", "ef68fb57a770de8a976b565e5fccc638be69d668ae08f5d05cf035a4862dd17b"],
  ["experiments/recovery-runner/tasks/median/subtle-wrong-output.mjs", "5535ba4a1e2019f86a844ffb997dec2a586a3310", "d0a0b8e6cca4e8beb2aa9e82aa68684d1f2fdb28f9febf4001d6275610c15441"],
  ["experiments/recovery-runner/tasks/median/task.json", "a2a54756806aadcbad638204784553e692a2ab4f", "b5eddc6043b0cdb302b86e8eafca0e55b68a1e5516b0ad20e4fc8a2071c115ef"],
  ["experiments/recovery-runner/tasks/parse-range/acceptance.mjs", "f2dda97f635c46aff3cbcff0d36e5921716d8b1d", "e9f1ad98629b544bf8f624aac2ba0802ef0049fcda0f7b0027888f8fb56a0dbe"],
  ["experiments/recovery-runner/tasks/parse-range/ground-truth.mjs", "46d0a5f522420f35176bee5ae7594e2eea7a2478", "121e0dc8b84d5a78a657e7a3fc813cffc52b367fb9e06cc59c2b63499707b1cd"],
  ["experiments/recovery-runner/tasks/parse-range/overfit-output.mjs", "0fb11af5447723451d92d73e9ead8df3a9756be9", "6913721794179658df79c7475600e95ab0496a6fe6e9cc86eae3681801e4b708"],
  ["experiments/recovery-runner/tasks/parse-range/prompt.md", "61020dee56ba30e0f20cd82b06f6b7119fdb65cb", "3a7ee3cfcc95c1671185ed2e1ea1da803516c52b0808ce51c0879c50f86c09b0"],
  ["experiments/recovery-runner/tasks/parse-range/reference-solution.mjs", "e0e721edf3d62298d8f45d08c918c581e30ce8ea", "272d4ce78c56260a5fde5a2db7ee20d261212cb472dc9834f23e82edb4e598dc"],
  ["experiments/recovery-runner/tasks/parse-range/subtle-wrong-output.mjs", "60cdbdc0da56592664e966e74203a9255b451956", "a1aff5c51a4f107539a857bf63ddde489c102e6bc8ed6ab6f57600e36975fefd"],
  ["experiments/recovery-runner/tasks/parse-range/task.json", "e23f24141523f800905a419c5fd719bc27773504", "a2e9fbf8175bb3277f4c74f9b12b5c66c624ce1cec458102f0bc90228a00e047"],
  ["experiments/recovery-runner/tasks/rf-money/acceptance.mjs", "edbca73a5c81f7b653f434839dd6acb65ecbb18e", "3b8f972006568fc6fe72b3fe5916caf3fd575934b9141144b5e559194e13b9e0"],
  ["experiments/recovery-runner/tasks/rf-money/ground-truth.mjs", "a68f7c94473ffd1af9e19db197b155d8e3d2ce12", "d0aca9b35840dc4c4de4daf9b1878c6d145a9a6e9a9b56d735ba1293c539108b"],
  ["experiments/recovery-runner/tasks/rf-money/payload-subtle.mjs", "9f528637198d5a23132914144bead76eadbe6e26", "a1915c398202b46a92f6b9d10989b4436343f9b62f70e9f09630177ee2900f80"],
  ["experiments/recovery-runner/tasks/rf-money/prompt.md", "ffb8076740d7bd0311d06c5835484973038f8586", "4caab6552759589629eea587f77e60e118f3b196eabe5bdbe5c67f4e61fa85f8"],
  ["experiments/recovery-runner/tasks/rf-money/reference-solution.mjs", "717901e59d81e91e053239d9869d64aff0de4f5d", "0d572d8a2cb95a5e65bbe507c8d9afb9f510cbe15519344a515d7753b28d0266"],
  ["experiments/recovery-runner/tasks/rf-money/subtle-wrong-output.mjs", "7438c756aacef7bc519a9e668e5913165476aca6", "50d1211fbfb0abec515f05db61c9a4831410c0b9b4450f6bc7f9a24ebc8a812b"],
  ["experiments/recovery-runner/tasks/rf-money/task.json", "dc573c432f27a1e87c8196414c77ee517dd35a72", "7d33aca39af6a9d303888e17a77e3d101eafbd4f19cb31f53cb647af9bef22cf"],
  ["experiments/recovery-runner/tasks/rf-roman/acceptance.mjs", "e46d9c80038ff0c747cdd47671b08e9b8a09dfd0", "6d752e9f1364c2da8af1f7b5819392b4196e0cdf521963a165148ad4ba90a7da"],
  ["experiments/recovery-runner/tasks/rf-roman/ground-truth.mjs", "d37c47d649b22a51cc6b9164639cbb6a964fa521", "b1460d0b0e47f6aab8ba384e9dddb569933b7cca9d64289269263566d0f7f156"],
  ["experiments/recovery-runner/tasks/rf-roman/payload-subtle.mjs", "08130dd37db91caf9d89f6ba2ff911e6b4adfb5a", "e1a7c71cd929e9d7c13ee0a15cf11dc354f3b401e6d7c15c129ef1093285768c"],
  ["experiments/recovery-runner/tasks/rf-roman/prompt.md", "05383d670442c2cf228c15566a7e7ccd44b6f871", "68cebd06f23f84dc16e4d7613b1e89d568d68fd54f6ea50cf60cd8a0d410d183"],
  ["experiments/recovery-runner/tasks/rf-roman/reference-solution.mjs", "506d9867720d2767166296c4b42f12a6e066029d", "d72c00bc07b130ecf76809d1ed6a739da699f1f99f73bf6a9c39d84c76b8c44e"],
  ["experiments/recovery-runner/tasks/rf-roman/subtle-wrong-output.mjs", "d8301186b6bd2efb7925d89671819da2864c2b64", "2b12a70ffd8abe09197182e871ab0a740139332651d5fa9f42841f6c36705d8c"],
  ["experiments/recovery-runner/tasks/rf-roman/task.json", "b0d5ee6f130382b9f7adc97b0e848ef07cb4626c", "e037f377b14120e08a5368266d19f9b0d5491855f6c4fe4089f85c60bd45b631"],
  ["experiments/recovery-runner/tasks/rf-units/acceptance.mjs", "7d1b812dcc8d493547ff260c622ceae6b2b21f66", "9796c3b16489824f79cf34edd5f29eb3a0e81c529e665e404ae87bdf2c0b2064"],
  ["experiments/recovery-runner/tasks/rf-units/ground-truth.mjs", "6f37f1abc974af25a89e02d6647b6774f0cc3b15", "9369b11fc477936a4d99efa94080cfc9cf9f0e3b50fcb6d3cea2706240d587f4"],
  ["experiments/recovery-runner/tasks/rf-units/payload-subtle.mjs", "aa7facfc20263d9e12c60aa9ce38968ae6a1fafd", "4f0670641ca3422a81754cc9e28b90384864b46e01c2f53138e3f40784372760"],
  ["experiments/recovery-runner/tasks/rf-units/prompt.md", "197f80cfc48316806e302fa5c942b73e56a47364", "de242f7c1d322eac6781d76889e229db70843c7aaed6f12ef9e757985c1a85c6"],
  ["experiments/recovery-runner/tasks/rf-units/reference-solution.mjs", "dac551ca6ff3d444ea3ebd77be6d80a9170607d3", "ad9c2cdca6819673e1f60946f775c91a1c97a8e388397f145bd6455c7ef25f03"],
  ["experiments/recovery-runner/tasks/rf-units/subtle-wrong-output.mjs", "5ee93b11c78f310c26b4c83f09ae4df536a8a6c1", "0350b8433fd24a9339c63c4ccad472431bdad54ee7a08b569a9e2365b7c0826e"],
  ["experiments/recovery-runner/tasks/rf-units/task.json", "83a5e257e847d481ded9f4b7975e52584691afb5", "b69098be64cefa97497c7b97e14b9ce0ea61545d3ad4acfdbf072ef6c40e262f"],
  ["experiments/recovery-runner/tasks/text-stats/acceptance.mjs", "3f57c3b93086b354f8f794e220f2e7571a6cbdde", "ded5dd69613e5c3e472d18a304ff643e7b7000641edfba8320b6afd6865f7d5b"],
  ["experiments/recovery-runner/tasks/text-stats/ground-truth.mjs", "a0053f4565e8dcbf6e3605967edb22174d5cd6d2", "2695844232c13cba92d1a3b544960c3d1300eb5ad38d81ffa82849f41be54183"],
  ["experiments/recovery-runner/tasks/text-stats/prompt.md", "22002147fc5ec2c1226aa5a063dc36b5d34b3d47", "3caf524e5768e60cc906f9f15553d582bbc97ba8ecce7b8408ff6bd41edf252b"],
  ["experiments/recovery-runner/tasks/text-stats/reference-solution.mjs", "634b34bb2a12f93751a3173ba7f28d522bbb8b8c", "0c55a2ed581cc5eb8b314bea444b5d00d98360dff88705640455b2b7b620bc27"],
  ["experiments/recovery-runner/tasks/text-stats/subtle-wrong-output.mjs", "d016ec13a48831a9f2f474c5ebc14985b240adf4", "c30330728c8f8f34e8710542f5e42ffc236c4d2ca9ef6a2ed8ad909174074d08"],
  ["experiments/recovery-runner/tasks/text-stats/task.json", "31710ef7ea90defa5e5b5ee3a57f63aed081143a", "8246a0a6c242d57ea01edbb6736b468bbe4106434f2a41efd54d7d2802847961"],
  ["experiments/recovery-runner/tasks/tr-clamp/acceptance.mjs", "cc922bfa2096f2063b8d0ee57793126621952744", "d04907e51c11b9a5b7fff6877cd5dd5d7d6e50a39d9fede623bbb9e3fb8c4eee"],
  ["experiments/recovery-runner/tasks/tr-clamp/ground-truth.mjs", "26305112f3d67dba2dffa9cfa4b95fcaafea52fe", "f7e8b06d07e8dd310793559e3b520e1908a70925a32f72c11be902b7f519d179"],
  ["experiments/recovery-runner/tasks/tr-clamp/payload-subtle.mjs", "ea820f19bccd728587c40c4a0cbc4176ca51e72e", "810833cf102d3610dde086fbda8773e53912d25bb36d060281cbf89656da52c6"],
  ["experiments/recovery-runner/tasks/tr-clamp/prompt.md", "986396a78f13b4617b77532d48e2273ef63f6888", "87e5a8d11e174282b9a08c9ca19de12fe1fd57947cccebb7c592bca8db6f4b25"],
  ["experiments/recovery-runner/tasks/tr-clamp/reference-solution.mjs", "1be95c66809d62f137d64c591e78d9ffc25ff70d", "d4ea8d9e301d9f357b48103c2828eb272517291baffcb3cfaa0f5ebfdc25e2e6"],
  ["experiments/recovery-runner/tasks/tr-clamp/subtle-wrong-output.mjs", "73f9eb74698ed39c93ee8e1271692af4164c726e", "3538639ca6377ce69b9b560dc396e18db5ceb4246604b0f2613a1d407128c7fa"],
  ["experiments/recovery-runner/tasks/tr-clamp/task.json", "fbdde001486829914a1bfa7fdc85cd72a8c2db84", "65e435fea6085669c9d7918983f41ad040c01201deec17a62ae6795b265f039f"],
  ["experiments/recovery-runner/tasks/tr-pluralize/acceptance.mjs", "11f8914f9fe03d71aeb19a5b53c2df61ef141033", "a5d1627d6e354c26b01163e7147797ebf27e49fc4b64d1a29ecf0cfdc8f4bdfc"],
  ["experiments/recovery-runner/tasks/tr-pluralize/ground-truth.mjs", "a2e97375a2a1bf548f27af169854c5df024c5504", "07a4e54896cf91db38e2203a2472b079b80f598981f4529efab3debc56f9cdf9"],
  ["experiments/recovery-runner/tasks/tr-pluralize/payload-subtle.mjs", "20e417d29d5a251fa67203107c9dc4b232f67f7f", "ec8359e9a990331b9a80020335ffdc205312d4983d5861e3dfcf9679d98fdef7"],
  ["experiments/recovery-runner/tasks/tr-pluralize/prompt.md", "615098ee24cd5a70b9d3025f827bc2b1b3a92533", "c9531eba5f85da2b746f8678724ebba17585ef1e0352fd7f97087eee8013f760"],
  ["experiments/recovery-runner/tasks/tr-pluralize/reference-solution.mjs", "e92ad3447ef4a10c315fb4bd52a6ebe0ecfd036a", "61e3925feacc89279693730e63050ce3b39c789a4e1133d7897f461e6f65ed45"],
  ["experiments/recovery-runner/tasks/tr-pluralize/subtle-wrong-output.mjs", "5a77691afe15a79a610b1728abde93ecb61b69f0", "1e306286ee51be083994c5103d50a35bf70dff8967f15c18282357fa3a462615"],
  ["experiments/recovery-runner/tasks/tr-pluralize/task.json", "53c7f390e6dee9e9becde8ad678738b473c335d5", "f922b94a6df4aca762a9532af4e6de096238f0d0336c286b3002b93b66647f9d"],
  ["experiments/recovery-runner/tasks/tr-slugify/acceptance.mjs", "0a37bb50ed8c886f2b069944fc93b84a55a33f74", "317b42528b8467e2d466033d60568d231d3e8a2a67a1bbbb58b1187292f85743"],
  ["experiments/recovery-runner/tasks/tr-slugify/ground-truth.mjs", "1b5672c1605d9283a345518354ee8353df2f2a95", "df547cbe6a04ddf8faca08de0538e0dca84b3e0ce4094db7a0ee1003b3fdacd7"],
  ["experiments/recovery-runner/tasks/tr-slugify/payload-subtle.mjs", "fb1ad84931fb7014a59ebf4c52afe349fada485a", "e22e528e7e933e484cb51ae0f9c747b1c69aa117bccb70240bfa30b0daf87ec0"],
  ["experiments/recovery-runner/tasks/tr-slugify/prompt.md", "849af55fea9913dc7d967f84301f79e107aa1a71", "e0e70a09cc041eae6e1cf9eb91d540e2b75c381e0f17b721513d68fe59c1dfe6"],
  ["experiments/recovery-runner/tasks/tr-slugify/reference-solution.mjs", "d9f53514e0fd1116c757bb251e60d588af7b72c0", "0bffc91c741ef35d9134604faeb43342441266cbfcc0d2d1915a2a2a945482a6"],
  ["experiments/recovery-runner/tasks/tr-slugify/subtle-wrong-output.mjs", "85ea10384f027a177d1bbfae3ff41b998588c502", "aff41c3b06bcdccd19b692ff5d741447b06157d83797a3a88b2f8d8a1140dc40"],
  ["experiments/recovery-runner/tasks/tr-slugify/task.json", "5e689941df98397ce73d722b87e7fcd8d37d539a", "25226f12068f844106eb6bd4cd5f29bae1b852179b144763019aac52a1f35a3a"],
  ["experiments/recovery-runner/text-stats-pilot.jsonl", "fdf47fa870f17893320ce807986084f9f15421ff", "48d7328ba4389c26a745c1cba7861a659514a32a74874766bb69bee73c89a0a1"],
].map(([path, gitBlobOid, byteSha256]) => ({ class: 'provenance_bytes', path, gitBlobOid, byteSha256 }));
const EXPERIMENT_PROVENANCE_PATHS = new Set(EXPERIMENT_PROVENANCE_ROWS.map((row) => row.path));

// Baseline of sorted `path NUL schema-token NUL count NUL contextSha256` rows.
// The exact row list is derived from tracked active source, while this digest makes
// additions, deletions, changed counts, moved paths, and context mutations fail closed.
const PERSISTED_SCHEMA_ROW_COUNT = 374;
const PERSISTED_SCHEMA_BASELINE_SHA256 = '4d40f26e2840e17d60a1473f75d108306f91df8c06dee84b9d969e60df39fcce';

const ACTIVE_CLASSES = [
  'package',
  'bin',
  'command',
  'agent_role',
  'environment',
  'path_config',
  'runtime',
  'prompt',
  'documentation',
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const initialCwd = resolve(scriptDir, '..');
let gitExecutable = null;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitCandidates() {
  const bundled = resolve(dirname(process.execPath), '../../bin/fallback/git');
  return [...new Set([
    process.env.PROOF_OR_STOP_GIT,
    'git',
    bundled,
    '/usr/bin/git',
  ].filter(Boolean))];
}

function selectGit(cwd = initialCwd) {
  if (gitExecutable) return gitExecutable;
  const failures = [];
  for (const candidate of gitCandidates()) {
    try {
      const top = execFileSync(candidate, ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (top) {
        gitExecutable = candidate;
        return candidate;
      }
    } catch (error) {
      failures.push(`${candidate}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
  }
  throw new Error(`tracked-file enumeration requires Git; candidates failed: ${failures.join(' | ')}`);
}

function git(args, options = {}) {
  const cwd = options.cwd || initialCwd;
  return execFileSync(selectGit(cwd), ['-C', cwd, ...args], {
    encoding: options.encoding === null ? null : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).trim();
}

function trackedFiles(root) {
  const output = git(['ls-files', '-z'], { cwd: root });
  const files = output.split('\0').filter(Boolean).sort();
  if (files.length === 0) throw new Error('tracked-file enumeration returned zero files');
  return files;
}

function countLiteral(text, token) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function occurrenceContextDigest(text, token) {
  const lines = text.split(/\r?\n/).filter((line) => line.includes(token));
  return sha256(lines.join('\n'));
}

function hasBroadToken(token) {
  return new Set([
    LEGACY_WORD,
    LEGACY_TITLE,
    LEGACY_UPPER,
    `${LEGACY_UPPER}_`,
    `@${LEGACY_WORD}/`,
    `.${LEGACY_WORD}`,
  ]).has(token);
}

function validateExactRows(rows, tracked, root, readText = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  const ids = new Set();
  const rowKeys = new Set();
  const signatureCoverage = new Map(FROZEN_SALTS.map((salt) => [salt, 0]));
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      errors.push('allowlist row is not an object');
      continue;
    }
    if (!row.id || ids.has(row.id)) errors.push(`allowlist duplicate/missing id: ${row.id || '<missing>'}`);
    ids.add(row.id);
    if (!ALLOWED_CLASSES.has(row.class)) errors.push(`allowlist ${row.id}: unknown class ${row.class}`);
    if (row.disposition !== 'frozen') errors.push(`allowlist ${row.id}: disposition must be frozen`);
    if (!row.reason || row.reason.length < 12) errors.push(`allowlist ${row.id}: reason is missing or too broad`);
    if (!row.path || isAbsolute(row.path) || row.path.includes('..') || /[*?\[\]{}]/u.test(row.path)) {
      errors.push(`allowlist ${row.id}: path must be one exact repository-relative file`);
    } else if (!tracked.has(row.path)) {
      errors.push(`allowlist ${row.id}: stale/missing tracked path ${row.path}`);
    } else if (statSync(resolve(root, row.path)).isDirectory()) {
      errors.push(`allowlist ${row.id}: directory exemptions are forbidden`);
    }
    if (!row.token || hasBroadToken(row.token) || /[*?\[\]{}]/u.test(row.token)) {
      errors.push(`allowlist ${row.id}: token is empty, wildcarded, or a forbidden broad identity`);
    }
    if (!Number.isInteger(row.expectedOccurrences) || row.expectedOccurrences <= 0) {
      errors.push(`allowlist ${row.id}: expectedOccurrences must be a positive exact integer`);
    }
    if (!/^[a-f0-9]{64}$/u.test(row.contextSha256 || '')) {
      errors.push(`allowlist ${row.id}: contextSha256 must be exact sha256`);
    }
    if (!row.verificationCommand || !row.expectedVerification) {
      errors.push(`allowlist ${row.id}: verification command/result is required`);
    }
    const key = `${row.path}\0${row.token}`;
    if (rowKeys.has(key)) errors.push(`allowlist ${row.id}: duplicate path+token row`);
    rowKeys.add(key);
    if (!tracked.has(row.path)) continue;
    const text = readText(row.path);
    const actualCount = countLiteral(text, row.token);
    if (actualCount !== row.expectedOccurrences) {
      errors.push(`allowlist ${row.id}: occurrence count ${actualCount}, expected ${row.expectedOccurrences}`);
    }
    const actualContext = occurrenceContextDigest(text, row.token);
    if (actualContext !== row.contextSha256) {
      errors.push(`allowlist ${row.id}: bounded context digest changed (${actualContext})`);
    }
    if (signatureCoverage.has(row.token)) {
      signatureCoverage.set(row.token, signatureCoverage.get(row.token) + actualCount);
    }
  }
  for (const [salt, count] of signatureCoverage) {
    if (count === 0) errors.push(`missing signature allowlist source row for ${salt}`);
  }
  return errors;
}

function isProtectedArtifact(path) {
  return path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.lattice/story/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/');
}

function verifyFrozenFiles(root, tracked, baselines = FROZEN_FILE_BASELINES) {
  const errors = [];
  const ids = new Set();
  for (const row of baselines) {
    if (ids.has(row.id)) errors.push(`frozen baseline duplicate id ${row.id}`);
    ids.add(row.id);
    if (!ALLOWED_CLASSES.has(row.class)) errors.push(`frozen baseline ${row.id}: unknown class ${row.class}`);
    if (!tracked.has(row.path)) {
      errors.push(`frozen baseline ${row.id}: missing tracked path ${row.path}`);
      continue;
    }
    if (!/^[a-f0-9]{40}$/u.test(row.gitBlobOid || '')) errors.push(`frozen baseline ${row.id}: invalid Git blob OID`);
    if (!/^[a-f0-9]{64}$/u.test(row.byteSha256 || '')) errors.push(`frozen baseline ${row.id}: invalid byte sha256`);
    let actualOid;
    try {
      actualOid = git(['hash-object', '--', row.path], { cwd: root }).trim();
    } catch (error) {
      errors.push(`frozen baseline ${row.id}: git hash-object failed`);
      continue;
    }
    if (actualOid !== row.gitBlobOid) {
      errors.push(`frozen baseline ${row.id}: byte mutation (Git blob ${actualOid}, expected ${row.gitBlobOid})`);
      continue;
    }
    if (!isProtectedArtifact(row.path)) {
      const actualSha = sha256(readFileSync(resolve(root, row.path)));
      if (actualSha !== row.byteSha256) {
        errors.push(`frozen baseline ${row.id}: sha256 ${actualSha}, expected ${row.byteSha256}`);
      }
    }
  }
  return errors;
}

function isProtectedExperimentPath(path) {
  return path.startsWith('experiments/baselines/') || path.startsWith('experiments/recovery-runner/');
}

function deriveExperimentProvenanceRow(root, path) {
  const text = readFileSync(resolve(root, path), 'utf8');
  return {
    class: 'provenance_bytes',
    path,
    gitBlobOid: git(['hash-object', '--', path], { cwd: root }).trim(),
    byteSha256: sha256(Buffer.from(text)),
  };
}

function verifyExperimentProvenance(root, files, rows = EXPERIMENT_PROVENANCE_ROWS) {
  const errors = [];
  const actualPaths = files.filter(isProtectedExperimentPath).sort();
  const expectedPaths = rows.map((row) => row.path).sort();
  if (new Set(expectedPaths).size !== expectedPaths.length) errors.push('experiment provenance: duplicate exact file row');
  for (const path of actualPaths) if (!expectedPaths.includes(path)) errors.push(`experiment provenance: missing exact file row ${path}`);
  for (const path of expectedPaths) if (!actualPaths.includes(path)) errors.push(`experiment provenance: stale exact file row ${path}`);
  for (const row of rows) {
    if (row.class !== 'provenance_bytes') errors.push(`experiment provenance ${row.path}: invalid class`);
    if (!row.path || isAbsolute(row.path) || /[*?\[\]{}]/u.test(row.path) || !isProtectedExperimentPath(row.path)) {
      errors.push(`experiment provenance ${row.path || '<missing>'}: path must be one exact protected file`);
      continue;
    }
    if (!actualPaths.includes(row.path)) continue;
    const actual = deriveExperimentProvenanceRow(root, row.path);
    if (actual.gitBlobOid !== row.gitBlobOid) errors.push(`experiment provenance ${row.path}: Git blob digest changed`);
    if (actual.byteSha256 !== row.byteSha256) errors.push(`experiment provenance ${row.path}: byte sha256 changed`);
  }
  return errors;
}

const SCHEMA_PATTERN = /(?:^|[^A-Za-z0-9_.-])((?:lattice|Lattice)[A-Za-z0-9_.-]*\.v[0-9]+)(?=$|[^A-Za-z0-9_.-])/gu;

function schemaRows(root, files) {
  const rows = [];
  for (const path of files) {
    if (!isActiveTextPath(path) || isFrozenSurface(path)) continue;
    const text = readFileSync(resolve(root, path), 'utf8');
    const tokens = new Set();
    for (const match of text.matchAll(SCHEMA_PATTERN)) tokens.add(match[1]);
    for (const token of tokens) {
      rows.push({
        path,
        token,
        count: countLiteral(text, token),
        contextSha256: occurrenceContextDigest(text, token),
      });
    }
  }
  return rows.sort((a, b) => `${a.path}\0${a.token}`.localeCompare(`${b.path}\0${b.token}`));
}

function schemaBaselineDigest(rows) {
  return sha256(rows.map((row) => `${row.path}\0${row.token}\0${row.count}\0${row.contextSha256}`).join('\n'));
}

function isFrozenSurface(path) {
  return path === SCRIPT_PATH
    || path === 'CHANGELOG.md'
    || path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.proof-or-stop/dev-memory/')
    || path.startsWith('.lattice/story/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/')
    || path.startsWith('docs/requirements/decisions/')
    || EXPERIMENT_PROVENANCE_PATHS.has(path);
}

function isActiveTextPath(path) {
  if (path.includes('/dist/') || path.includes('/node_modules/')) return false;
  if (/\.(?:png|jpe?g|gif|ico|pdf|zip|gz|tgz|woff2?|mp[34]|mov)$/iu.test(path)) return false;
  return true;
}

function scanRootGroups(files) {
  return {
    packages: files.filter((path) => /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/u.test(path)),
    runtime: files.filter((path) => path.startsWith('packages/main/src/') || path.startsWith('packages/utils/src/') || path.startsWith('packages/lab/src/') || path.startsWith('bin/') || path.startsWith('scripts/') || path.startsWith('.githooks/')),
    agents: files.filter((path) => path.startsWith('packages/main/templates/agents/') || path.startsWith('.claude/agents/') || path.startsWith('.proof-or-stop-codex/agents/')),
    docs: files.filter((path) => ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/CLI.md', 'docs/guide.md', 'docs/guide-hooks.md', 'docs/host-run-usage.md'].includes(path) || path.startsWith('.github/')),
  };
}

const TOKEN_PATTERN = /@lattice\/[A-Za-z0-9._/-]+|__?LATTICE_[A-Z0-9_]+|LATTICE_[A-Z0-9_]+|\.lattice(?:-[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]*)?|lattice\.config\.json|lattice\.json|lattice-[a-z0-9-]+|[A-Za-z0-9_.-]*lattice[A-Za-z0-9_.-]*|Lattice[A-Za-z0-9_]*|LATTICE[A-Z0-9_]*/gu;

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const endIndex = text.indexOf('\n', index);
  return text.slice(start, endIndex === -1 ? text.length : endIndex);
}

function isSignatureOccurrence(path, token) {
  return EXACT_ALLOWLIST.some((row) => row.path === path && row.token === token);
}

function classifyToken(path, token, line) {
  if (RETIRED_ROLES.has(token)) return 'agent_role';
  if (token.startsWith(`${LEGACY_UPPER}_`) || token.startsWith(`__${LEGACY_UPPER}_`)) return 'environment';
  if (token === `${LEGACY_WORD}.config.json` || token === `${LEGACY_WORD}.json` || token.startsWith(`.${LEGACY_WORD}`)) return 'path_config';
  if ((path.endsWith('package.json') || path.endsWith('package-lock.json') || path.endsWith('npm-shrinkwrap.json'))
    && (token.startsWith(`@${LEGACY_WORD}/`) || /["']name["']\s*:\s*["']lattice["']/u.test(line))) return 'package';
  if ((path.endsWith('package.json') || path.endsWith('package-lock.json'))
    && /["']lattice["']\s*:/u.test(line)) return 'bin';
  if ((path.startsWith('bin/') && path.includes(LEGACY_WORD)) || /(?:^|\/)lattice(?:\.js|-codex\.js)$/u.test(path)) return 'bin';
  if (path.startsWith('packages/main/templates/agents/') || path.startsWith('.claude/agents/') || path.startsWith('.proof-or-stop-codex/agents/')) return 'prompt';
  if (/\.md$/u.test(path) || ['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(path)) return 'documentation';
  if (new RegExp(`(?:^|[^A-Za-z0-9_-])${LEGACY_WORD}\\s+[a-z][a-z0-9_-]*`, 'u').test(line)) return 'command';
  return 'runtime';
}

function scanActiveResidue(root, files) {
  const hits = [];
  const schemaSet = new Set(schemaRows(root, files).map((row) => `${row.path}\0${row.token}`));
  for (const path of files) {
    if (!isActiveTextPath(path) || isFrozenSurface(path)) continue;
    const absolute = resolve(root, path);
    let text;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const token = match[0];
      if (schemaSet.has(`${path}\0${token}`) || isSignatureOccurrence(path, token)) continue;
      const line = lineAt(text, match.index);
      hits.push({ class: classifyToken(path, token, line), path, line: lineNumberAt(text, match.index), token });
    }
    for (const match of path.matchAll(TOKEN_PATTERN)) {
      const token = match[0];
      hits.push({ class: classifyToken(path, token, path), path, line: 0, token: `<path:${token}>` });
    }
  }
  const deduped = new Map();
  for (const hit of hits) deduped.set(`${hit.class}\0${hit.path}\0${hit.line}\0${hit.token}`, hit);
  return [...deduped.values()].sort((a, b) => `${a.class}\0${a.path}\0${a.line}\0${a.token}`.localeCompare(`${b.class}\0${b.path}\0${b.line}\0${b.token}`));
}

function verifyOrdering(root) {
  const errors = [];
  const isAncestor = (older, newer) => {
    try {
      git(['merge-base', '--is-ancestor', older, newer], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  if (!isAncestor(POLICY_COMMIT, 'HEAD')) errors.push(`ordering: policy commit ${POLICY_COMMIT} is not an ancestor of HEAD`);
  const policyPaths = git(['show', '--format=', '--name-only', POLICY_COMMIT], { cwd: root }).trim().split('\n').filter(Boolean);
  if (policyPaths.length !== 1 || policyPaths[0] !== POLICY_PATH) {
    errors.push(`ordering: policy commit must contain only ${POLICY_PATH}`);
  }
  const introductions = git(['log', '--diff-filter=A', '--format=%H', '--', SCRIPT_PATH], { cwd: root }).trim().split('\n').filter(Boolean);
  if (introductions.length !== 1) {
    errors.push(`ordering: expected exactly one committed RED verifier introduction, found ${introductions.length}`);
    return errors;
  }
  const redCommit = introductions[0];
  if (!isAncestor(POLICY_COMMIT, redCommit)) errors.push('ordering: RED verifier commit does not descend from policy commit');
  if (!isAncestor(redCommit, 'HEAD')) errors.push('ordering: RED verifier commit is not an ancestor of HEAD');
  const redPaths = git(['show', '--format=', '--name-only', redCommit], { cwd: root }).trim().split('\n').filter(Boolean).sort();
  const expectedRedPaths = ['package.json', SCRIPT_PATH].sort();
  if (JSON.stringify(redPaths) !== JSON.stringify(expectedRedPaths)) {
    errors.push(`ordering: RED commit changed unexpected paths: ${redPaths.join(', ')}`);
  }
  const intermediate = git(['log', '--format=%H', `${POLICY_COMMIT}..${redCommit}^`], { cwd: root }).trim().split('\n').filter(Boolean);
  for (const commit of intermediate) {
    const paths = git(['show', '--format=', '--name-only', commit], { cwd: root }).trim().split('\n').filter(Boolean);
    const forbidden = paths.filter((path) => !path.startsWith('.lattice/story/actives/B-022e/') && !path.startsWith('.proof-or-stop/story/actives/B-022e/'));
    if (forbidden.length > 0) errors.push(`ordering: pre-RED commit ${commit.slice(0, 12)} changed production/non-story paths: ${forbidden.join(', ')}`);
  }
  try {
    const packageAtRed = JSON.parse(git(['show', `${redCommit}:package.json`], { cwd: root }));
    if (packageAtRed.scripts?.['test:proof-or-stop-identity-cutover'] !== EXPECTED_PACKAGE_SCRIPT) {
      errors.push('ordering: RED commit does not bind the exact focused package target');
    }
  } catch {
    errors.push('ordering: cannot parse package.json at RED commit');
  }
  return errors;
}

function runSelfTest(root, files) {
  const failures = [];
  const expect = (condition, message) => { if (!condition) failures.push(message); };
  const injections = [
    ['package', 'package.json', '@lattice/lab', '"@lattice/lab": "1.0.0"'],
    ['bin', 'packages/main/package.json', 'lattice', '"lattice": "dist/cli.js"'],
    ['command', 'scripts/injected.mjs', 'lattice', 'run lattice help now'],
    ['agent_role', '.claude/agents/injected.md', 'lattice-review-story-init', 'lattice-review-story-init'],
    ['environment', 'packages/main/src/injected.ts', 'LATTICE_DEBUG', 'LATTICE_DEBUG'],
    ['path_config', 'packages/main/src/injected.ts', '.lattice', '".lattice"'],
    ['runtime', 'packages/main/src/injected.ts', 'latticeRuntime', 'const latticeRuntime = true'],
    ['prompt', 'packages/main/templates/agents/injected.md', 'Lattice', 'Lattice agent'],
    ['documentation', 'AGENTS.md', 'Lattice', 'Lattice product'],
  ];
  for (const [expected, path, token, line] of injections) {
    expect(classifyToken(path, token, line) === expected, `injected active residue was not classified as ${expected}`);
  }

  const tracked = new Set(files);
  const first = EXACT_ALLOWLIST[0];
  const source = readFileSync(resolve(root, first.path), 'utf8');
  const virtualRead = (path) => (path === first.path ? source : readFileSync(resolve(root, path), 'utf8'));
  const stale = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, expectedOccurrences: row.expectedOccurrences + 1 } : row);
  expect(validateExactRows(stale, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'stale allowlist count mutation did not fail');
  const broadened = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, token: LEGACY_WORD } : row);
  expect(validateExactRows(broadened, tracked, root, virtualRead).some((error) => error.includes('forbidden broad')), 'broadened allowlist token did not fail');
  const missingRow = EXACT_ALLOWLIST.filter((row) => row.token !== FROZEN_SALTS[1]);
  expect(validateExactRows(missingRow, tracked, root, virtualRead).some((error) => error.includes('missing signature allowlist')), 'missing allowlist row did not fail');
  const missingOccurrenceText = source.replace(first.token, `proof-or-stop-review-integrity-v1`);
  const missingRead = (path) => (path === first.path ? missingOccurrenceText : readFileSync(resolve(root, path), 'utf8'));
  expect(validateExactRows(EXACT_ALLOWLIST, tracked, root, missingRead).some((error) => error.includes('occurrence count')), 'missing frozen occurrence did not fail');
  const frozen = FROZEN_FILE_BASELINES[0];
  const mutatedBytes = Buffer.concat([readFileSync(resolve(root, frozen.path)), Buffer.from('\nmutation')]);
  expect(sha256(mutatedBytes) !== frozen.byteSha256, 'frozen-byte mutation did not change digest');
  const experimentMutation = EXPERIMENT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, byteSha256: '0'.repeat(64) }
    : row);
  expect(
    verifyExperimentProvenance(root, files, experimentMutation).some((error) => error.includes('byte sha256 changed')),
    'experiment provenance byte mutation did not fail',
  );

  if (failures.length > 0) {
    for (const failure of failures) console.error(`SELF-TEST FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS identity-cutover self-test: injected active residue, stale/broadened/missing allowlist, missing occurrence, and frozen/provenance-byte mutations all fail closed');
}

function main() {
  const root = repoRoot();
  const files = trackedFiles(root);
  if (process.argv.includes('--print-experiment-baseline')) {
    console.log(JSON.stringify(files.filter(isProtectedExperimentPath).map((path) => deriveExperimentProvenanceRow(root, path)), null, 2));
    return;
  }
  if (process.argv.includes('--self-test')) {
    runSelfTest(root, files);
    return;
  }

  const groups = scanRootGroups(files);
  const emptyRoots = Object.entries(groups).filter(([, paths]) => paths.length === 0).map(([name]) => name);
  if (emptyRoots.length > 0) {
    console.error(`FAIL identity-cutover infrastructure: empty tracked scan roots: ${emptyRoots.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const schemas = schemaRows(root, files);
  if (process.argv.includes('--print-schema-baseline')) {
    console.log(JSON.stringify({ count: schemas.length, sha256: schemaBaselineDigest(schemas) }));
    return;
  }

  const structuralErrors = [
    ...validateExactRows(EXACT_ALLOWLIST, new Set(files), root),
    ...verifyFrozenFiles(root, new Set(files)),
    ...verifyExperimentProvenance(root, files),
    ...verifyOrdering(root),
  ];
  const actualSchemaDigest = schemaBaselineDigest(schemas);
  if (schemas.length !== PERSISTED_SCHEMA_ROW_COUNT || actualSchemaDigest !== PERSISTED_SCHEMA_BASELINE_SHA256) {
    structuralErrors.push(`persisted_schema: exact baseline changed (rows=${schemas.length}, digest=${actualSchemaDigest})`);
  }

  if (structuralErrors.length > 0) {
    console.error('FAIL identity-cutover: frozen boundary or lineage invalid');
    for (const error of structuralErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const hits = scanActiveResidue(root, files);
  if (hits.length > 0) {
    console.error('FAIL identity-cutover: active legacy identities remain');
    for (const className of ACTIVE_CLASSES) {
      const classHits = hits.filter((hit) => hit.class === className);
      if (classHits.length === 0) continue;
      console.error(`  [${className}] ${classHits.length} occurrence(s)`);
      for (const hit of classHits.slice(0, 8)) console.error(`    ${hit.path}:${hit.line || 'path'} ${hit.token}`);
      if (classHits.length > 8) console.error(`    ... ${classHits.length - 8} more`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('PASS identity-cutover');
  console.log(`PASS unchanged: ${FROZEN_SALTS.length} signature salts at ${EXACT_ALLOWLIST.length} exact source rows`);
  console.log(`PASS unchanged: ${FROZEN_FILE_BASELINES.length} named historical/provenance byte baselines`);
  console.log(`PASS unchanged: ${schemas.length} exact persisted-schema rows`);
}

main();
