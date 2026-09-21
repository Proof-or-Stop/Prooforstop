













import { FINAL_NEGATIVE_CONTEXT_ROWS } from "./negative-contexts.mjs";
import { EXACT_ALLOWLIST } from "./base-contexts.mjs";

export const REVIEWED_NEGATIVE_SOURCE_INTEGRITY = [
  {
    "path": "packages/main/tests/global-core-realpath.test.mjs",
    "sha256": "387ff3d85490ead23ca8780190574a02148163cca9a924d18af9193ae24b32f0"
  },
  {
    "path": "packages/main/src/core/runtime-environment-checks.ts",
    "sha256": "02afe26ceb22b9fa4c0597aa326c2f02cbb5a65f6fd1d8f1137ba5b867a0ed1a"
  },
  {
    "path": "packages/main/src/tasks/agent-dispatch-registry-smoke.ts",
    "sha256": "24af594852084dbc894fc0e65537e8da70d878469326ae81cd93d9b9b421294a"
  },
  {
    "path": "packages/main/src/tasks/certification-window-smoke.ts",
    "sha256": "9ee5b823317b03c313374136687c7af5da0c0c50eef3d47539c24e8116b6f4af"
  },
  {
    "path": "packages/main/src/tasks/command-ownership-contract.ts",
    "sha256": "e11b33faca79f113aa6b1812ca0c0fed288ecec182578fd9d58d356d402671d4"
  },
  {
    "path": "packages/main/src/tasks/flow-stability-smoke.ts",
    "sha256": "48b043c9ae0c3b02451b6cd6edd8f873a4c227d0b9c46a418aac83cb564a3705"
  },
  {
    "path": "packages/main/src/tasks/global-agents-unit-smoke.ts",
    "sha256": "8aeb3b110704050e50f455033f60d189ffabbde769822d428d63472168c65b47"
  },
  {
    "path": "packages/main/src/tasks/prompt-contract-measurement-smoke.ts",
    "sha256": "4300984893dd7fb0dd1987b16ff873fc45abb82c98fdde01dae9236bae2d5590"
  },
  {
    "path": "packages/main/src/tasks/prompt-registry-smoke.ts",
    "sha256": "7a52f86676b0037f6119617c608dab62fb99dd174fb75360d8d84e002ddca11f"
  },
  {
    "path": "packages/main/src/tasks/prompt-token-cost-smoke.ts",
    "sha256": "bbb2013b1d126282edf1ce47de453064f4242521ac0d6295ed06be4ef38bb09b"
  },
  {
    "path": "packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts",
    "sha256": "f83f5c84c3ba9b3b95d6fcea1b8a705d89363161459b973313a1630bd91774c2"
  },
  {
    "path": "packages/main/src/tasks/proofstory-pre-review-check-smoke.ts",
    "sha256": "397d2499ed65e79ec7102995ada2093fcde6381781a90e4f916b139c5aae275b"
  },
  {
    "path": "packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts",
    "sha256": "0148ddf4e99b3efdb4fa914596c474d22c17ac893bc05a74bab61962ecc81d7c"
  },
  {
    "path": "packages/main/src/tasks/review-inventory-handler-smoke.ts",
    "sha256": "f0749dc539c87c76b1072c3a869aa229d49e43b7a10e30dc3ba529d29a2b7daa"
  },
  {
    "path": "packages/main/src/tasks/thin-init-assets-smoke.ts",
    "sha256": "d5f66049f670b99d57df8c7fbcdce35fc8b3b5531a3238090d2324edb61985fe"
  },
  {
    "path": "packages/main/src/tasks/version-bump-smoke.ts",
    "sha256": "24e9fc05585731b70adc7850f9fb08202b95857126e7878126b559e4c48a27cd"
  },
  {
    "path": "packages/main/tests/artifact-schema-migration.test.mjs",
    "sha256": "f8fc062c976d719f418e44df0535d65634fdd65c4df5fcb80e4eff1793ee3216"
  },
  {
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "sha256": "7086f8ed638a6134be65b44d8a499c6d85590514be90dea05b1e8ea0a7df9aed"
  },
  {
    "path": "packages/main/tests/bin-alias-migration.test.mjs",
    "sha256": "b8152639bce087b87cbfd55bca169ce805a81a71d4b4f3cc1f9147b95d97f620"
  },
  {
    "path": "packages/main/tests/brand-role-migration.test.mjs",
    "sha256": "0fd66798b51ff2ba2db25dcab13078b2cfe9d68581ffbbebe3ba85f5c22eaa2c"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "sha256": "e39265a2fba165adfd5c5210f2d4d8147bfe985fec8f77f63384972897539c13"
  },
  {
    "path": "packages/main/tests/f080-story-create-canonical-reviewer-guidance.test.mjs",
    "sha256": "1c816299468dce646ba5137bf647a6caa8601fa6479df17e3601a3a7c258e798"
  },
  {
    "path": "packages/main/tests/f081-f085-canonical-role-boundaries.test.mjs",
    "sha256": "9277c705129a9cd15160c043a439e9ae86688a62714c66417bb665de46246613"
  },
  {
    "path": "packages/main/tests/lab-brand-migration.test.mjs",
    "sha256": "5bf82221848b0502eed75288387649159a735de71874920914f093eb98a87669"
  },
  {
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "sha256": "399506981692f1fd53815b2a87f189f1f4d39d756262e852773e825937249856"
  },
  {
    "path": "packages/main/tests/managed-marker-migration.test.mjs",
    "sha256": "ac923854f781ab1a96ad1430b4234531df5811aa64200cd35e6cdfe5e50950e9"
  },
  {
    "path": "packages/main/tests/package-identity-migration.test.mjs",
    "sha256": "2ff4765736009577ce4c44aeda16b9c5335240391188cce67bc94268f798f730"
  },
  {
    "path": "packages/main/tests/prompt-role-migration.test.mjs",
    "sha256": "64d8b8595ea8803596857eafe06b9f95a212ed86978ca4407748ebbac680ce30"
  },
  {
    "path": "scripts/verify-codex-assets.mjs",
    "sha256": "e23ebef3d7a921c085531f1f71267a1306fe775f7407dd4b1588c5bf0c72c873"
  },
  {
    "path": "scripts/verify-core-package-rename.mjs",
    "sha256": "7f23fcf9bcc27e82eb44ac988853bf72dc032d0eb05b64800b1d72a53d11a43a"
  },
  {
    "path": "scripts/verify-entrypoints.mjs",
    "sha256": "af6854f6258ea29b73d9016fdc73343d43ebae2770be8c2387c0e0dfd1076d78"
  },
  {
    "path": "scripts/verify-global-lab-entrypoint.mjs",
    "sha256": "da5bb5c6c8265e76de0be218329392743331adffbdc72d2d66356ff37c7be1c4"
  },
  {
    "path": "scripts/verify-migration-contract.mjs",
    "sha256": "75de0e714349006cd3cf40ce2f8b5466347e2e8d9d8444d6a8e9540ca5e4d2ad"
  },
  {
    "path": "scripts/verify-process-fact-contract.mjs",
    "sha256": "14ed10e886ff2375ca13ba64a8023f9934d8a8599f7790846c49934956b3c4db"
  },
  {
    "path": "scripts/verify-proof-or-stop-prompt-baseline.mjs",
    "sha256": "8594c7d7fbd448a33725ecee1a25dec9a9cadc81c3a0dcd5086aa27990c657ce"
  },
  {
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "sha256": "fc740a0c825153e6f535f72f76554331de2f83bd6d779718557fa3e1b7c6f970"
  },
  {
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "sha256": "b9f26844c46c956d7b94eaae07625263076b5ecb657ba2c719e23f58a74f6b31"
  }
];

export const CLOSED_ROLE_NEGATIVE_ROWS = [
  {
    "id": "closed-role-negative-2",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "assert.doesNotMatch(output, /subagent_type: \"lattice-review-story-init\"/);",
    "expectedOccurrences": 1,
    "contextSha256": "d0159dbd02a747f9c2827b86216a7602a96f8a636f419ef58cbc692d0b4a371e",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-3",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "assert.doesNotMatch(output, /agentType\":\"lattice-review-story-init\"/);",
    "expectedOccurrences": 1,
    "contextSha256": "f3be5b820fda1ff000e95361817cfae2877a408253654d81aeb6a91b00565f59",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-4",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "assert.doesNotMatch(error.message, /lattice-review-story-init/);",
    "expectedOccurrences": 1,
    "contextSha256": "321122e81b688154fc80a2f65188e3621eafcbac008b047d3c85ee7c787c55bb",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-5",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/b90d6-init-dispatch-guidance.test.mjs",
    "token": "storyId, agentType: 'lattice-review-scope-plan'",
    "expectedOccurrences": 1,
    "contextSha256": "4b7c772e82e35e9d87d55c356a762e3d0fe7b336299edeccda35efeb4aa079ab",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-6",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "token": "roleId: 'lattice-review-quality@historical', terminal: false",
    "expectedOccurrences": 1,
    "contextSha256": "ddfc8416ce5f641128edb91c7af63e8f0e9165f9577594081f01221dd4db82e4",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-7",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "token": "roleId: 'lattice-review-quality@historical', terminal: true",
    "expectedOccurrences": 1,
    "contextSha256": "8e1978e19eff129b2f5966e4ad08f6bbc3d360305377a6df05b8f4914520fccf",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  },
  {
    "id": "closed-role-negative-8",
    "class": "compatibility_fixture",
    "path": "packages/main/tests/legacy-role-alias-sunset.test.mjs",
    "token": "'lattice-review-quality', 'verification-intent', 'proofbound-review-quality', 'unknown-review-role'",
    "expectedOccurrences": 1,
    "contextSha256": "df05799e5c1dbf0ca88d8328c6544cad54b39a84952cf2960b2414ab818cbb8d",
    "reason": "Independently verified retired-role dispatch rejection and historical observation without readable alias authority; canonical controls and input non-mutation are retained.",
    "disposition": "frozen",
    "verificationCommand": "internal:verify-exact-frozen-occurrence",
    "expectedVerification": "PASS exact closed-role negative context"
  }
];

FINAL_NEGATIVE_CONTEXT_ROWS.push(...CLOSED_ROLE_NEGATIVE_ROWS);

EXACT_ALLOWLIST.push(...CLOSED_ROLE_NEGATIVE_ROWS);

export const CLOSED_ROLE_RUNTIME_WITNESSES = [
  { path: 'packages/main/tests/b90d6-init-dispatch-guidance.test.mjs', command: 'packages/main/tests/b90d6-init-dispatch-guidance.test.mjs', selector: 'b90d6-init-dispatch-guidance: ALL PASS' },
  { path: 'packages/main/tests/legacy-role-alias-sunset.test.mjs', command: 'packages/main/tests/legacy-role-alias-sunset.test.mjs', selector: 'legacy role alias sunset contract test passed' },
];

export const INTEGRATION_ROOT_HISTORY_CONTEXT = {
  id: 'integration-root-index-removal-history',
  class: 'provenance_bytes',
  path: 'docs/requirements/decisions/b-49df-main-integration-provenance.md',
  token: 'lattice.config.json',
  expectedOccurrences: 1,
  contextSha256: '1c5baa40c23c10f7a7b60b58f17be9ba45d23e1e42b3a6cd57966bad6c18a035',
  reason: 'Exact historical index-removal evidence table; the retired root configuration is denied, never a current lookup input.',
  disposition: 'frozen',
  verificationCommand: 'internal:verify-integration-root-history-context',
  expectedVerification: 'PASS exact current quotation context; no historical object authentication',
};

EXACT_ALLOWLIST.push(INTEGRATION_ROOT_HISTORY_CONTEXT);

export const OWNED_IDENTITY_MUTATION_CONTEXT_ROWS = [
  ["proofbound.verification-receipt-bundle.v5",1,"2fb9434ea351105317bfa7e1f6bf15560dbe4f4681ebf73af0aa6b1b22e02955"],
  ["lattice-evaluator",1,"2d96a1f44ffa2eb05931241226d5de899f06a5b7566a4280ab1be887f659c6c2"],
  ["lattice-implementer",1,"f23fa45cc02552afdfdbed39f510f7f802ecab624f652c4b77cdd967f9ff17ac"],
  ["lattice-review-behavior",1,"bb4852595cc7fc8b1b26ccf5543a890a344dc9a19c6cbe2a7c33ee63bb5576fb"],
  ["lattice-review-concept",1,"f1aee775601d04f50ceba85dc2cad00eab41606d7a6aef1f59748d8cbd44333b"],
  ["lattice-review-delivery",1,"4d88dd1ec4dbade655bb71b633e09e1cab7bbbb00e88ce410642f0d89c68c33a"],
  ["lattice-review-docs",1,"22ba64eb6decaa0732ecc938e1243ee884d042284157cf0c056c69794da2c711"],
  ["lattice-review-quality",1,"3287d166851568de782063047864dc0a2f304b9bf4f546f68443277300a39c70"],
  ["lattice-review-run-workspace-binding-v1",1,"a5ccdcd7f60c1d0d71ad85f49ce4fcbd3dc242c42e1cb144ab8e5b63c5e8785e"],
  ["lattice-review-scope-plan",1,"c16c13cbe506ab84d1cca13376dd1f28476a0fb2baf9fd84063cbe3c40e57bcb"],
  ["lattice-review-story-init",1,"e5d9be534ed6e73c45ea47494e435cbe7334f165e0537643b2f213f044dc4673"],
  ["lattice-review-test-coverage",1,"d6bce1d9772c390a55768488b618bd3ac5bd86bce47c1fb9ea7615d51b857336"],
  ["lattice-review-topology-critic",2,"bcc97e6209398c0b91f66d79a4bfe16b3ff449fc7e307a5588ed0f6b8c467339"],
  ["lattice.evidence_hash_snapshot.v1",3,"c9631c0dedd8954ae56932c500c92bcf629647fba8e7112729f988c8c7cdb255"],
  ["lattice.proof_admissibility.v1",3,"4dbbe7a3e32c2fe86f1b89fa172ade086254fe4c7f622dbd65454091ae613ea7"],
  ["lattice.proof_admissibility_verifier.v1",3,"a38123b77874b352d5c95b94e90aebee359b0b2bfaca88bde1cbfd7f16959ed6"],
  ["lattice.quantum_claim_admissibility.v1",3,"9d76fa71707f7702b184306ce533e403e7bad03f661c80b30388478c8ab818cf"],
  ["lattice.quantum_claim_admissibility_verifier.v1",3,"140cba5a7d60988f0bb82f14be442636195fd76a20b8a9e1b57da05dd2d3b0c5"],
  ["lattice.queue_exception_registry.v1",1,"357ad5000df1bee2f379a49c17ad90c79a31f25d3e701d12699061e0bc7786ab"],
  ["lattice.queue_exception_set.v1",1,"d1ef0563b6d9381a5e80111ce74c9b68c0b63f98b1122aac43af302168748220"],
  ["proofbound-code-runtime",1,"aecabbf8608fa67d693da8a3f184281083faa4f43fba1d23b51e727048b26f42"],
  ["proofbound-evaluator",8,"98315a6ac3f8f96d949b1417a59108fa032eb755a47db35aa8f8a835b9d3f3ef"],
  ["proofbound-evaluator-cli",4,"b29d4346ec3c85c1f59857752a1d6f98c3b10232f174bee2273777aa69849d46"],
  ["proofbound-implementation-reviewer",4,"c53ade05bdfec81e0c56e04e101a9c3de39eafe7a5034545f9750377ea0436ab"],
  ["proofbound-implementer",8,"638ed385f4e95baed86faab28f5a12481aba68b084cca2d557ef85286f694355"],
  ["proofbound-memory-baseline-global-",1,"ad24bd05e6064cbd42e7543353bf441957bdf8f5b2a727066a8f83afdcdb3b55"],
  ["proofbound-memory-baseline-matrix-",1,"81b010c6c3abc8e2caa180216b562d98f96d17061b8acf6291bc96f9aafed134"],
  ["proofbound-memory-baseline-runtime-",2,"23998295137b6ad03d351d093c1f27dbc81698011fe63c871d13142cbd62d725"],
  ["proofbound-memory-baseline-runtime-corpus-",1,"c4c738abfb3e5193f8a83d60cff9009dc8da14d9f66efd9887f75303d1f161e7"],
  ["proofbound-product-reviewer",6,"3497e3fafcc3063a8d5e1d2dcbd59b10ef4741c562aa94cbabebbe1e57067628"],
  ["proofbound-review-behavior",8,"afb9966acc28c2b5702dc329141fca5e351b66c3fa737e2bc8a772aa33d43393"],
  ["proofbound-review-channel",8,"61651c66f5f988c613fc5b77311cdef76e0e3474c0c0e08598830ed1d2eeb161"],
  ["proofbound-review-concept",8,"cf84747be652582faad863e3d5f8210ba381a37aa15fdaff2f5ef476d37c4d78"],
  ["proofbound-review-delivery",10,"965653f1ee58381a3bfbbe7a1f52f6c98d79da76b1c402f77889ab82917317d5"],
  ["proofbound-review-docs",8,"75cc592f52ce9ae50d1c405f790d82074cca42c3cf06f504173bc6ec5b03e769"],
  ["proofbound-review-quality",8,"7eae1d9df79bbba580d31c020ca790f65f71dc5a2599a43d4eeca2333513e3ba"],
  ["proofbound-review-scope-plan",10,"c4523b7e18ed340a4c97d795d2f215b71a37cbc0793b537b321af8f97ae8d0c9"],
  ["proofbound-review-story-init",8,"8fb4a7eba67222c5f14e590b07f2c4be9192d6098fd82864bcc50efb584d76f4"],
  ["proofbound-review-test-coverage",6,"1ca3fb31362860f72e75710e8d80378b4808e1863b9144c63cc4267b7bda86aa"],
  ["proofbound-review-topology-critic",10,"1ff0ee2efb8157fa34677708a542f79c460b55c9c27d6b3dfaeae5b12d6bd4a7"],
  ["proofbound-test-case-reviewer",4,"a878292f7a0ac0c3d47f66784f66f63708fffc26130156a54e91cd265a7b4a8c"],
  ["proofbound-test-intent",4,"3ecbbde186a6470078995c272c4fa3c861a0a2a62220cd2c1fd0ef3942f33263"],
  ["proofbound-verification-intent",4,"1b52ac90e97b135daf917679904856b8c44c89e9d57fe93c347b04c4d7191711"],
  ["proofbound.agent-runtime.v1",2,"42dcc1e66764931d8ff418e780564ceab425187078cd0c7b9f22bcb96b2bfcbc"],
  ["proofbound.candidate-spec-set.v1",1,"9b0c7fd2190d207289d319cb1bae800054dbe21b6dc99775def2b7a810001f61"],
  ["proofbound.canonical-json.code-point-keys.v1",4,"032cd4a7ea83eb7245d59fd1ad18761d3e248b403dcc942eaf78bc7de7e1e451"],
  ["proofbound.capability-release-backfill.v1",1,"ff285bfe39f28fee13d95d40178f4402f4c989180c114ba6f30f84c50f9df0e7"],
  ["proofbound.certification-window.v1",1,"104d245388e0fcde08b4e31a548c9b7beb4604749eaf41f1592db80fdf675350"],
  ["proofbound.certification_windows.v1",1,"bb748e61b7ecb23753a4723d326640fd94e77f70e3c34637d4e9a8d6143e160c"],
  ["proofbound.dev-memory-finish-decision.v1",1,"1bc6c4fc894935eff145db24a1766ea2b65178d6b04863d52fd0472a142bbae8"],
  ["proofbound.evidence-activated-advisory-playbook.v1",1,"66b288858677c5c9e9f5ac36f38ece2d9d2cf8ac5b7b8c9c16a68f132f8c1344"],
  ["proofbound.final-response-check.v1",1,"3b0cde1d6cb515c6e258f284749d67d3c1989b8f5df02df874a56b45eac96b63"],
  ["proofbound.keyword-proposal.v1",2,"cf15b09a43d173042e1a66b628b301dd43a661dd710ec924c1445703c7fc7504"],
  ["proofbound.keyword-seeds.v1",1,"364bc676fdd158884264abaa662d7d2492fe17fffb1d866ecf39fb2d03f0da6c"],
  ["proofbound.learning-source-key.v1",1,"c39a0f697e6ed72a6451214fd176956af956a07f81efe7197089127e3a6e419c"],
  ["proofbound.lifecycle.init-to-done.v2",4,"15f2d4945c071c62006e800a050d17dd2f36b3f64135366a2a72c04c9feae73c"],
  ["proofbound.memory-playbook-baseline.gold.v1",1,"74debf2d70d1e8f788a9011177c715521afa1e57777832549e25142bb814e209"],
  ["proofbound.memory-playbook-optimized-parity.v1",1,"c2e0443b27cdb04e7172bf36e8c9238c5122fdb8354c84c2c852449981662d80"],
  ["proofbound.milestone_closeout.v1",1,"a597032720ea96df42e2be55ebf5d34da85d7d3221d7e8e0e7fd2961be5da052"],
  ["proofbound.milestone_closeout_missing.v1",1,"189518c23ae83e6bdb7b5e334b127f795c575c0897e48ea30b62c41e725d1250"],
  ["proofbound.non-deducible-source.v1",1,"34c3660dc4dfb1b5501256d1a92ec174ff51ca3ec12f2f378cee2fc9116e4db2"],
  ["proofbound.non-deducible-sources.v1",1,"c3d3e7ad00d89b66968a1223134b01b6c3eb1ed64c6910ab126529ca30c7ea94"],
  ["proofbound.playbook-auto-activation.v1",2,"4c91b68f152b5f861781a1f168fbe5e89f0c83fdc34a9b2e1f0ecfbbe0202cfc"],
  ["proofbound.playbook-auto-promotion-apply.v1",1,"53047872b3a356344970310eee28fee5ca57c40f0f9bf083a9552ee6fd446a2d"],
  ["proofbound.playbook-candidate-batch-manifest.v1",1,"6c86456e4679e3428bcfd2fde1415fabfb73702ad937847ed5286e0dd12caed7"],
  ["proofbound.playbook-candidate-ingest.v1",1,"ba2b44abefe10d7ca70e5406d213452ddb108875255f7bfb422800d36c6b766e"],
  ["proofbound.playbook-outcome.v1",1,"d205fb6b07d2698a275d939b9d3cf349f317d75d092ee9a6aa0e69b0ee79fa3e"],
  ["proofbound.playbook-promotion-decision.v1",3,"e8e9aafa71169b6dd5ed23c6bc320bf2b3e5f56ff16ee01c178a2b0b827248e9"],
  ["proofbound.playbook-promotion-health.v1",2,"f3e735f157c96b211755fc5128a0829b5ecf862858ada615e5896ced12397d48"],
  ["proofbound.playbook-promotion-observe.v1",1,"e97d3d6971d0204d33874e32d8277d49004448d4b1a4cb9159406f9ff85920c6"],
  ["proofbound.playbook-promotion-timer.v1",1,"906a43292b7a2e504affa80a77c74db15d2cc1b759c801ee2971f24f15697180"],
  ["proofbound.playbook-runtime-consumption-verify.v1",1,"d301225d3cd4420ba5ae854290e13519d6e5460c65a7689a56831041cd25780c"],
  ["proofbound.playbook-seed-backfill.v1",1,"4db010981979f2c5eac8a91a7863a49b5ba3c3c683d3924e6daf378f1fe9b24f"],
  ["proofbound.playbook-seed-propose-batch.v1",1,"1fb93a178d0244c863ae22f3113b9a9bf564e33dca0998d813c8e6cf457a66ff"],
  ["proofbound.playbook-trial-control.v1",2,"7c2153cb8c6246be27c52a8725944b25309afd090fc8576837e37d38d6f9f318"],
  ["proofbound.playbook-trial-run.v1",1,"ac00286dca98e6cce798728a15929ba19100a70f064ce59d918d092c4918623a"],
  ["proofbound.precert-receipt.v1",1,"15f8df1e3db1b5555ebfbeaeb5f701a714ab340d68d0acc1b6079403b92c8341"],
  ["proofbound.precert_receipt.v1",1,"3ee73ae737fb09659c29c37625e4115a60aa2f7a2484a0514c56cab0a18d468e"],
  ["proofbound.product-capability-release.v1",1,"bcc692efc7be5140570179a24efd02874f2720da513409f1895cfa31e2802b40"],
  ["proofbound.prompt-envelope-rollout.v1",1,"dc61202e31a5c475cf24cf8dd3218af6fb3215476c71b6468aec40e1e139ef2a"],
  ["proofbound.prompt-measurement-report.v1",2,"3e33a4c99b1c8d7ff502eeb48d13c9cc29a0810f2d681d83b345025716205496"],
  ["proofbound.prompt-role-contract-registry.v1",2,"87e31db7612133dec01a455591b38592bcd8b9cc12b8edb3e9678d6bfcdf4910"],
  ["proofbound.queue_exception.v1",1,"0008de2856a3754d6aa546acbf720fda98120bff660626a5cbc8a83b518dbee2"],
  ["proofbound.review-inventory-critic-receipt.v1",1,"321bc2cd046199e9088e40835746e4f12afe91741293f7df8f06e06e4979dfed"],
  ["proofbound.review-inventory-epoch.v1",1,"2152c085e7750a42834770dd58d16cf48be4a2b33c5bbb2af497fb75121b64de"],
  ["proofbound.review-inventory-receipt.v1",1,"f935c8302e29070aea95aec76da978ec239020b0ac76eba3f5ec6852de99affa"],
  ["proofbound.review_inventory_critic_receipt.v1",1,"b64cedea1ee30c32581d1eff2252ecd7810bc1425d30d53e55b826ff0df88e4b"],
  ["proofbound.review_inventory_epoch.v1",1,"82b5ed81713171b49a256a6e46243385fc30f717aff495a5c358908629f685f7"],
  ["proofbound.review_inventory_receipt.v1",1,"8c079227aa603c336264fbf1dd84143c53bb39bc85efc614d8b43b95fcd472f8"],
  ["proofbound.review_run_list.v1",1,"ae43051e1a56e34c522448965a6c52f3c0068033fb78f3d088f9d4aadb772ecf"],
  ["proofbound.reviewer-host-render-identity.v1",1,"e1a7b75ddfb3fe4b94fb15e423db27f50d331ca75bbc34faf5020d6da3fca1af"],
  ["proofbound.role-contract.v1",2,"5c32df5c65c8a8e730547111a7f7247b9de136fa4b6e2761d7ced678342309c3"],
  ["proofbound.signed-process-facts.v1",4,"5675001deb045c0002adb7d8446fa2976bca3816b5463f4803728a1b4e607eee"],
  ["proofbound.story-owner-boundaries.v1",4,"c5fb2d7d95165eae67eee4a761b08aa61ae7b70be0912878bcf4c3999b29846a"],
].map(([token, expectedOccurrences, contextSha256], index) => ({
  id: `owned-identity-mutation-${index + 1}`, class: 'compatibility_fixture',
  path: 'packages/main/src/core/runtime-environment-checks.ts', token, expectedOccurrences, contextSha256,
  reason: 'Exact fail-closed mutation metadata input, bound to independent source inventory, actual public-operation cases and historical or explicitly constructed provenance; never runtime alias admission.',
  disposition: 'frozen', verificationCommand: 'node packages/main/tests/canonical-new-story-artifacts.test.mjs --group=identity-sites',
  expectedVerification: 'GREEN B-49df: identity-sites group pass.',
}));

EXACT_ALLOWLIST.push(...OWNED_IDENTITY_MUTATION_CONTEXT_ROWS);

export const BOTH_FAMILY_CONTEXT_ROWS = [
  ["packages/main/tests/brand-role-migration.test.mjs","proofbound-review-quality",2,"ce5548010842c37dd9329abdaadbfd8d1a13af87eef7fa51dc294fdc641c6308","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/checklist.json","; .codex/hooks.json is neither, which is why Proofbound survived. Add JSON host assets under .codex/ and .claude/ to the scan roots with the same deprecate",1,"a4633d374ab9e70e0de04f4e38a81b81bc1228b22b7818763a75a26781f7e7f9","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/index.json","ed ROOT_MARKERS, deprecated alias fallbacks, Proofbound statusMessage strings). Regenerate them fully on main, and add a smoke that renders the generator o",1,"33dfd134a02450393ce20678f9820d168b5441f7fe7cc14c307be5748b4c3a08","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["packages/main/src/tasks/command-catalog-smoke.ts","assert.doesNotMatch(helpOutput, /Proofbound/, 'help must not print the legacy Proofbound product name anywhere');",1,"55649ea8494c215048a19f1dcb3da742591c3d6223836151b8930e9862367ae8","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","// this inventory specifically so active proofbound protocol literals or",1,"360530bd2123c42ef12c5ce94b715cecb9b3f19152573bc4da4e6b89fe127230","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs",", 'CHK-007:edge:0 frozen proofbound history stays byte-identical and is rejected by active readers', () =>",1,"ac46d7f5af2afc2060115d73d97e493dfb87017ebf218029cc4ff253165ef283","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs",", 'CHK-007:adversarial:0 proofbound injection at every active boundary fails closed with zero mutation', () =>",1,"5faf7bdaaf63f9f8b46c2640d3b6fdf5c97001d7fb7454badd7315aad8b35e34","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["docs/requirements/decisions/claude-session-b-cdf6-review-convergence-analysis-and-optimization.md","> Proofbound 的生命周期、reviewer 编排、证据写入和验收模型，在哪些位置把一次正常的实现—审查—修复过程放大成了多轮重复工作？",1,"c53fd27427997f24090b13e286bddb940b4878122d6a1befd7a3638b1c950c2d","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/milestone-ledger-status-review-findings.md","`/Users/jek/Documents/Work/proofbound/.worktrees/B-b550`. The retired",1,"18c7c970ef63b8449d434c81c02ebbf34b5c0a0345bfb868449f146db76bdc86","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/orchestrate-retirement.md","| B-3523 | `/Users/jek/Documents/Work/proofbound/.worktrees/B-3523` | preserved, not normalized |",1,"0193096213ccb09c302c9a0c5166bc5759b9fe361382e3d669a3bad029a8eb23","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/orchestrate-retirement.md","| B-fbb6 | `/Users/jek/Documents/Work/proofbound/.worktrees/B-fbb6` | preserved, not normalized |",1,"8e05367179635a8bade4944b1145c3fcdacc9eca8ca6c11187a2bd43aa77f2fc","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md","| Repository | `proofbound` |",1,"c6fabdfbfb3213f16ec650e7d01e844d0e127c376a492417e0edd1eb93b73f11","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/background.md","/hooks.json statusMessage strings still read Proofbound instead of Proof-or-Stop. B-af1b only appended its own entries and did not repair this, because it ",1,"7f94ba793527508f4abf21fdfa37e36592c81f389417fcc3832395e59139c2a0","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/background.md","e narrowed to the files that story owns. The Proofbound statusMessage is a brand-rename residue that the residue verifier does not scan because .codex/hook",1,"9814fbce828b637aad15547148ce64e41d5a5dc90d1c0b30f2a0167b642b1df2","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["packages/main/src/tasks/evidence-retention-gc-smoke.ts","PROOFBOUND_TEST_ACTOR_KEY",1,"9dc84e85e42f53e72b8f9d35b3a8fe0f2e9d904bc3a5eb2da223348a71adb26d","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  [".proof-or-stop/dev-memory/finish-decisions/B-0b50.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-1482.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-16df.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-1734.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-1e1f.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-2220.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-3434.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-3e16.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-41c8.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-45a0.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-45a5.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-49ed.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-5952.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-5a15.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-5a88.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-6693.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-74b9.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-7dff.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-8af0.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-8df9.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-9a49.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-9f2c.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-9ff1.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-a2a6.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-a745.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-cc10.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-d15e.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-d854.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  [".proof-or-stop/dev-memory/finish-decisions/B-dc2e.json","proofbound.dev-memory-finish-decision.v1",1,"98e842f59bd8cc5276644d0e2dcd18d1323a6eaf795e6404d6cc9fd7061294c8","persisted_schema","Exact pre-cutover signed finish-decision schema bytes; preserve the record, never admit it to a current active reader."],
  ["docs/story/drafts/codex-hook-assets-drift-from-generator/checklist.json","ks rewritten, hooks.json statusMessage still Proofbound). GREEN: after the commit the same sequence leaves an empty diff. Restore the paths init --upgrade ",1,"b7336c4387e65c52936b049c57b28242960f207b1088e761ae5dd91d843f429e","provenance_bytes","Exact historical quotation, import metadata, preserved worktree location, or defect observation; not a current command or schema instruction."],
  ["experiments/multi-model-ablation/cell06-docker-probe/negative-controls/host-path-contamination.json","\"value\": \"/Users/jek/Documents/Work/proofbound/.proof-or-stop/secret\"",1,"3d918e6bf8474a0973b0959a932a9ccc2d0c9d01c9c9dbe0661b078d9e75c1ef","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["experiments/multi-model-ablation/cell06-docker-probe/negative-controls/proofbound-memory-contamination.json","proofbound-memory-contamination",1,"32e4faf877df157c500ceaf27e2b85207d3b97f50b1a7dc8d791fd717fa7b497","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority.",true],
  ["experiments/multi-model-ablation/cell06-docker-probe/negative-controls/proofbound-memory-contamination.json","Proofbound-memory",1,"5fe40880a0c7d8d72051513edf7376cc79eb732b47f82c92ceb7b86860846e16","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["experiments/multi-model-ablation/cell06-docker-probe/probe-manifest.json","proofbound-cell06-codex-probe",1,"2298b058065cb0ba0d548d31fbc871a2becaf7963fd36efa4c22f2a500a699d9","provenance_bytes","Exact completed Cell06 probe evidence bytes; current producer changed independently and does not rewrite prior results or authorization."],
  ["experiments/multi-model-ablation/cell06-docker-probe/probe-rows.jsonl","proofbound-cell06-codex-probe",2,"7752b70c3cff700b1c18490cd4e4741c44aa696ff89d75e7d463dbba975b8d5b","provenance_bytes","Exact completed Cell06 probe evidence bytes; current producer changed independently and does not rewrite prior results or authorization."],
  ["experiments/multi-model-ablation/cell06-docker-probe/probe-rows.jsonl","proofboundMemoryLeak",2,"7752b70c3cff700b1c18490cd4e4741c44aa696ff89d75e7d463dbba975b8d5b","provenance_bytes","Exact completed Cell06 probe evidence bytes; current producer changed independently and does not rewrite prior results or authorization."],
  ["experiments/multi-model-ablation/cell06-docker-probe/validate-probe.mjs","proofbound-memory",1,"4a6b9017cedb4361bc659b09d9596c83bad1a5e3c3b0d7a3e5755fa583641479","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/core/runtime-environment-checks.ts","retiredNeedle = canonical.replace(/^proof-or-stop/u, 'proofbound'),",1,"afcc2837563573b1c1fee780141a0506578dbd3987a53ef3e4bbb6df6202acfa","compatibility_fixture","Exact unsupported-family mutation constructor metadata; synthesizes rejection controls and never resolves an active alias."],
  ["packages/main/src/core/runtime-environment-checks.ts","retired = canonical.replace(/^proof-or-stop/u, 'proofbound'),",1,"ce6c078cd961186d1e30222b08ab78cb1176e9877b75f5c7caa5d825488f773a","compatibility_fixture","Exact unsupported-family mutation constructor metadata; synthesizes rejection controls and never resolves an active alias."],
  ["packages/main/src/tasks/command-catalog-smoke.ts","// B-cdf6 CHK-002: the product name is now Proof-or-Stop (the legacy 'Proofbound'",1,"f622688ba0faba3e7c816f38df4ff257a49c0bdd9e359e2030729ea52d7c080e","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","'  at frame /Users/jek/Documents/Work/proofbound/packages/main/dist/core/machine.js:179:11\\n'.repeat(5_000)",1,"c6a765deebc23f736cbecbd364adbe3ec153bfff5d1a63579892c727dbd8de04","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","`(owner cwd: /Users/jek/Documents/Work/proofbound/.worktrees/B-bf52). \"story_advance\" is an owner-gated storyScopedMutating command, ` +",1,"a7ef85e99a4cf68a4265c8e5f0264b07034ddf806dd7a688bc41b7be1e541477","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","a: 'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate',",1,"c0b905f7b02f3154b5766bb76d0c7af03dbbd24bc7882c50d1b3e7683b392ec0","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","a: 'ENOENT reading \"/Users/jek/Documents/Work/proofbound/packages/main/src/core/machine.ts\"',",1,"1a8f9b11507cd623addd55c99653bcf4c6090bfe274bb5aa959c701b2166e206","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/convergence-breaker-smoke.ts","a: 'story lock cwd=/Users/jek/Documents/Work/proofbound/.worktrees/B-bf52 is held elsewhere',",1,"0c777443f00cb13bc0f66d0ae08294031cb47890f5f3f8264535f22bcb9cf0c5","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/dev-memory-supersession-smoke.ts",".some(tag => tag === 'proofbound' || tag.includes('proofbound')), `$",1,"eaf13bcb25ae4b660c8b5b47159e37d63b5d007cd5baa8339d40d29e4f132bdc","compatibility_fixture","Exact raw historical tag assertion restricted to five fixed pre-cutover project IDs; newly generated global fixtures forbid the retired tag."],
  ["packages/main/src/tasks/dev-memory-supersession-smoke.ts",".every(tag => !tag.includes('proofbound')), `$",1,"01ebe57bbe312336da30c94ca8c03531ce445e84fda972685ca39f810b1728f5","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/playbook-runtime-memory-m3-m6-smoke.ts","mergedInto: 'proofbound',",1,"8c1426260aa633e85a020d0856989545c39843c994d5fd42c99997111bb360fa","compatibility_fixture","Exact historical deprecated-tag fixture field used to exercise deprecated-term observations; not proof of rejection or current tag emission."],
  ["packages/main/src/tasks/usage-sweep-smoke.ts","const codexCwd = '/Users/jek/Documents/Work/proofbound/.worktrees/B-70e9';",1,"00bff076769a0dbb7ce3af4e3cdba33e3dd5d468d7a70bb10684e25a23f1f1b3","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/src/tasks/usage-sweep-smoke.ts","type: 'assistant', timestamp: '2026-07-10T02:00:00.000Z', cwd: '/Users/jek/Documents/Work/proofbound/.worktrees/B-70e9', requestId: 'req_1', message:",1,"85554fe596f2b668eba4c0ee755a373ba182da673b5852d7972dcce996897da9","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","/retired|proofbound|unsupported|unexpected|pinned|provenance|allowlist/i,",1,"ac899cff98f276f54bda8c39e62eac61881cf45ac8ea24dd2025ded8015a7ab2","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","/retired|proofbound|unsupported|unexpected|allowlist|schema/is,",1,"62d0b0b5c4eb59006d2c4a5bb5584f6b8aeb88efa85627c64151a95f11f44e4f","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","assert.equal(/proofbound/iu.test(readFileSync(join(repoRoot, path), 'utf8')), false, `$",1,"7eef367f9b5eb038c73b01cfb659f24b339e41dde992e3fda28150d7f88a52f8","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","assert.equal(/proofbound/iu.test(bytes), false, `$",1,"97b2e85d00c912d1dbada8741102737d5c26b412f7f11f5648736e8bc859c03f","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","assert.ok(identityCase.retired.startsWith('proofbound.') || identityCase.retired.startsWith('proofbound-'), `$",1,"a5d6d90f0f359d936965876c05c9f88954ed38e86b9a089c8ef344b32bc6c9b7","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts.test.mjs","'proofbound-'",1,"a5d6d90f0f359d936965876c05c9f88954ed38e86b9a089c8ef344b32bc6c9b7","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/prompt-role-migration.test.mjs","proofbound.prompt-registry.v1",1,"94ff59bed270fbcc9eda265e6f179dfdd44e927b3f0972a33923d09866db4500","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/red/red-s3-differential-probe.mjs","'volatile machine-absolute path', 'volatile', 'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate', 'validation lock held at /private/var/folders/zz/T/proof-or-stop-abc/.proof-or-stop/locks/validate'",1,"24ac9f6cf3589bdff771e5edfee56b7af522bb75a04855bfd4ef832686484837","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/red/red-s3-digest-collapse.mjs","'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate',",1,"2f5cc620006a939032a2ee1cb7444b189314d76fa646fae40ae0c93d7d986f6b","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/release-push-approval-migration.test.mjs","proofbound.remote-push-approval.v1",1,"7b43c8c4ec1bff21bf8d6151f139c3e649a8718d0d6f14fa0fa9ffe79800bab2","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
].map(([path, token, expectedOccurrences, contextSha256, classification, reason, allowFilename = false], index) => ({
  id: `both-family-context-${index + 1}`, path, token, expectedOccurrences, contextSha256,
  class: classification, reason, disposition: 'frozen',
  historicalStatement: classification === 'provenance_bytes', allowFilename,
  verificationCommand: 'internal:verify-both-family-contexts',
  expectedVerification: 'PASS exact independently classified historical or negative context',
}));

EXACT_ALLOWLIST.push(...BOTH_FAMILY_CONTEXT_ROWS);

export const BOTH_FAMILY_CONTEXT_WITNESSES = [
  [0,"0fd66798b51ff2ba2db25dcab13078b2cfe9d68581ffbbebe3ba85f5c22eaa2c"],
  [1,"ebdcc59f439a3e890e6a4c6b7a0a6c523cc0cb37a343cea8af0aa5d1cb498748"],
  [2,"d1261e4856fd3441f6ba185e3cc3a0e3222145e69218180ca3567888f848a694"],
  [3,"65b3a71a775eef59f9398fc88bae41728f07d0ff832b3164fc4a6305f2829b78"],
  [4,"7dee0a6347c1609c8812bd7c10299cabbdcdf8532db95ff0450deacbedcf1be4"],
  [14,"6ce71b767c7003c53068880527a14a0986692d4e80283ffbae217fad0af98fa5"],
  [15,"9101f015dcbfe0affcca0cecc2bc15ac9d1e691af1c5febbe249746d16536b60"],
  [16,"c182058690e5e55d41d91f5bc496acbe21b126e29e310525e4f4b1f3895cba21"],
  [17,"438a1d64432dd513be0a365831bf260c5dd3f06a664ee26a91d4ec85612acecc"],
  [18,"e682201fcd919fed8b31298c5f9fea4a2f4074a79acdf36283d1895752a8254b"],
  [19,"99f4f22d9a18956841357ccdbc27b2f379043be626da5644dd646b84d4d019cb"],
  [20,"a9d4b98b556f6fc86b10c0ffdc5428efd9fdc3ff726c49d7d1aaca72cddfb153"],
  [21,"60f20b105f498895f236dfad760345cf70f513d36d52e906808ef1354d832b36"],
  [22,"c77d7847d413037394c5c2f6a33b1ad096a21d027da2b38d4efa072b1bfd5515"],
  [23,"6123835d0e76ab25fb522130d2fb0a3d6d9f9c8a5671498d799054075539c4cd"],
  [24,"b64a701e7111d9e38a6fa9eeb33aa29557820a13e8b0e6551760542308e662f4"],
  [25,"793e99306f265c4eee27d3f909cadaae7c1f8aafa1efcf3aa7dc788e838b4f2a"],
  [26,"1f46856a5c0bb12fde681a4bf6361714c51b831a9c5e6cb42eeb86111cd4ad72"],
  [27,"fdd5c1a51c573e6407e884326dbec519d3b926ad84dd877ad9ae935976be4975"],
  [28,"4f8f72584e07b1687cca8147e648b87f279417df95461f98af20cd55665e2ee1"],
  [29,"eeed0ce3c76402d35b80ab28feb714e09e609daa00a1f5a1c1ebea634b3f4145"],
  [30,"7654530d129b96fcceee9333976da1d38f3be2b7a1a9d75e6414cc608a93f240"],
  [31,"018e370fbbfc8a0a3ccd8273c430bd2f1a6e89da44e85463238d360a0855b330"],
  [32,"d0697d2522c9b760ab4311e884f9a1152bf288716cffb0e21c4372b0959b0ee0"],
  [33,"42767df1b1d8a19995890722dbacf7e09e127ac5ae7480ff1858e4cf88284479"],
  [34,"f8aeb47bd6d7c182ad0fa205a064d2baad6073fee0b51613698677529235e96c"],
  [35,"cb428e7d74fec6edf0a793df0dedd0bc0217b95b13dafec4116848d32812167c"],
  [36,"e38507976e13d5ad83c5a3aec638bff1a1309c24e1a5ac40535f61ca6b1ab218"],
  [37,"6a670b33f25d9f121c47c4b935643635f5b43b86f20604f260d58db378419dbe"],
  [38,"2b7480f4412b755b6d63ea7971e7452338c798d9e3ebaf421e6fd4f20c6ae4e5"],
  [39,"aeeba6f2f2af24a0a7a198af2a40158725547589b632ec50a6f8bbeb80070f28"],
  [40,"eab566b1f5ec64152a186e2e7d8798181dc94ead09bce29d0e0d0cdd9bf44e93"],
  [41,"29e4ebfba3757034cb06d9beae3272dccac8b75911674143c8ff9384bde9ad6c"],
  [42,"6af4d5cc0a83c04bc92dddf004159badc857161214512a4b0996bee237aaaa6f"],
  [43,"3415e6ef07f528e911b673151b1dd40a325cf05d75253272da4ddc19e5c87019"],
  [45,"ef0ee67a627af9fa8d46115714543c1cd18b9c278d9526dd605f40b581366470"],
  [46,"c2567f39e9f08dfcdc472a3b7b8a5a60f9e8efe33b9e386d24773c79071b8328"],
  [48,"cc44ed2de501ece64b10585468721b50cfc9f628f62e0deb03af8240d4615847"],
  [49,"8c9b8d8a5a9bf9b715ffaaaebb88c42c8bcc38258e2953356e09be5aabc44b3a"],
  [51,"6266521612a843fb549a70c35df31e281f153749c0e7fcba2b2aa4eccce19fa4"],
  [52,"02afe26ceb22b9fa4c0597aa326c2f02cbb5a65f6fd1d8f1137ba5b867a0ed1a"],
  [55,"0a0e8086be494cbf378b488a2d891a43db5559f077042ac6da87cfd4a90375d0"],
  [60,"bb56479da5c58cf6baccddf3cbde7255e82c0e0fd805acc6a412ffee6a728758"],
  [62,"9ee8a71dcfaacfc632a7756be28b1ade7039a97650843eb0389591d0747c44ca"],
  [63,"2c66ecdd669663680f3ec141617a929b29ae53ca6a603f1d6a31197dfdcd4be4"],
  [71,"64d8b8595ea8803596857eafe06b9f95a212ed86978ca4407748ebbac680ce30"],
  [72,"bba76d9fccb473fe801af115aad9eb59c82f382d0934a14f69cfce860d0c376f"],
  [73,"42de93915352c14e2962c733365adfd1c840a9b12cce78bf4bcfa201676a6870"],
  [74,"e5259450c31aa3feeaaebcb83fa32adc5f171019564c121d10cb87889c1e584d"],
].map(([rowIndex, sha256]) => ({ path: BOTH_FAMILY_CONTEXT_ROWS[rowIndex].path, sha256 }));
