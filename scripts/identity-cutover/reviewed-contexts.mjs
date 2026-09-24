













import { FINAL_NEGATIVE_CONTEXT_ROWS } from "./negative-contexts.mjs";
import { EXACT_ALLOWLIST } from "./base-contexts.mjs";

export const REVIEWED_NEGATIVE_SOURCE_INTEGRITY = [
  {
    "path": "packages/main/tests/global-core-realpath.test.mjs",
    "sha256": "387ff3d85490ead23ca8780190574a02148163cca9a924d18af9193ae24b32f0"
  },
  {
    "path": "packages/main/src/core/runtime-environment-checks.ts",
    "sha256": "32c50661e5df14c86ebd3e045016b3faddcf6f7e91c20156cb7c08819100a05f"
  },
  {
    "path": "packages/main/src/tasks/agent-dispatch-registry-smoke.ts",
    "sha256": "c56b0226bd11da1e0c24ecd9707effab6f3e0ee955d3459c41f2bfbbcf927a2e"
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
    "path": "packages/main/src/tasks/review-inventory-handler-smoke.ts",
    "sha256": "d4bd3e22ffff603bb11465b3fbf8d9796c3ba7742867ce4c2ef28962ebe75aad"
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
    "sha256": "07722bc047a07b196fea23643fff172046f525fba35f7c40a7b67b6bec1209c3"
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
    "path": "scripts/verify-proof-or-stop-residue.mjs",
    "sha256": "fc740a0c825153e6f535f72f76554331de2f83bd6d779718557fa3e1b7c6f970"
  },
  {
    "path": "scripts/verify-runtime-fact-contract.mjs",
    "sha256": "4717c27cfbd32b70d5893934ca5867519552f9172062f4c6758c50c29c80ab07"
  },
  {
    "path": "scripts/verify-process-fact-contract.mjs",
    "sha256": "4cae0412f265e7e484046955be3724e58ad9db42f7d8144f0d4a400f6aa0a093"
  },
  {
    "path": "scripts/process-fact-contract/catalog.mjs",
    "sha256": "d543e361b027b0c271f224cbf5c5b392017afbb3c453dc444657741409ea0e3a"
  },
  {
    "path": "scripts/process-fact-contract/cli.mjs",
    "sha256": "05a8d71ef7097534d9157a671f7064f8ee3e8104468b6aed832276befaf622d0"
  },
  {
    "path": "scripts/process-fact-contract/command-contracts.mjs",
    "sha256": "bea4a6a77c6ad328676fd473d332778b58f9edb909edc6b24ee59f3e9f1ef2fa"
  },
  {
    "path": "scripts/process-fact-contract/complete.mjs",
    "sha256": "874f6b304ec281c072136f13e213cb23a9b8c01160778dfc29bd1d5155c89436"
  },
  {
    "path": "scripts/process-fact-contract/early.mjs",
    "sha256": "4083dfa76b144461ade3746e8b055a1b23a8cd83241d2dc77657e4ed6933156d"
  },
  {
    "path": "scripts/process-fact-contract/prompt-contracts.mjs",
    "sha256": "a2c58a9f27140afb4d6860f9f0fe59a4b0e2a6d37523d3e46800be791bf97373"
  },
  {
    "path": "scripts/process-fact-contract/proofstory-closeout.mjs",
    "sha256": "27e11b9921b0b76ebdaac9005b5b5347829ad105f069b0ee0f9e7627e98b5239"
  },
  {
    "path": "scripts/process-fact-contract/registry-alignment.mjs",
    "sha256": "707f217734ad0f0df5813a0ae75baa40bda1a0983f424df23ac2b8a8367a6d68"
  },
  {
    "path": "scripts/process-fact-contract/registry-parser.mjs",
    "sha256": "38af42c68c72796d2bac71860b636000975e25dac9ae38b8c45eaab3ef0be847"
  },
  {
    "path": "scripts/process-fact-contract/reopen.mjs",
    "sha256": "81dd7cf3c21cac445d55d97c9179301756413ff64be4fb5f8c515d096a854837"
  },
  {
    "path": "scripts/process-fact-contract/review-inventory.mjs",
    "sha256": "30ff7404d46f732ba5e83e58c21dbaa7eba07e2b5dbcfa06b3cdbbb37501d1e0"
  },
  {
    "path": "scripts/process-fact-contract/review-verification.mjs",
    "sha256": "05c70988cc3ce2a506ea153244fa4a01d9018367f6bb4a55901c8a979528ebcc"
  },
  {
    "path": "scripts/process-fact-contract/scope-runtime.mjs",
    "sha256": "35442f569768d755d9915f95f73a23ca7744f05683711129dfcd3e0e48e53bee"
  },
  {
    "path": "scripts/process-fact-contract/source-analysis.mjs",
    "sha256": "e8165cead3176947c0f9ab961e82af8edf81888302a8a0a24a1f1e4e64a2ac26"
  },
  {
    "path": "scripts/process-fact-contract/story3.mjs",
    "sha256": "dc16ce8507ad30976b55fb54bbe8bc235aaa02a06f66aa78da995d7e17272c4f"
  },
  {
    "path": "scripts/process-fact-contract/support.mjs",
    "sha256": "51df56b4ee5729467a5399e3b9aacd8bfc70571511241f4b759d2e86e6ecaeea"
  },
  {
    "path": "packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs",
    "sha256": "b0da36165f1c3a5d0f868a455a2c52a8ad0a5613d5b23d9069950d4a8f35b448"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/callback-inventory.mjs",
    "sha256": "2d0173d44d0768fddf7aa6c94bb857416d5cdf3ebe2834abc1f73a828d311231"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/catalog.mjs",
    "sha256": "848ca779b21c249657ddbb2a531495046b6dcc26e09200541f29e601ec949d7a"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/cli.mjs",
    "sha256": "fc60c1a551c78a817d7ca479bd570d56a84f4fcd3a16e3cf5401253a286e2ea5"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/containment.mjs",
    "sha256": "f40f364c4396201745ae8c17ad1c5c73c953f8df30ff1bd7602f64f324c462d0"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/coordinator-wiring.mjs",
    "sha256": "fc66e8903b590f5cc52ac7cfb114536ff1af2dea8fa2d479647f0aef059e869f"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/driver.mjs",
    "sha256": "ca898f84f8c3147f382b878dab1f643403a148839aacf2ea868f9157d7d99ae6"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/environment-closure.mjs",
    "sha256": "7e972edf1c117d0614b499cb681c93686c2923d6fdabd4b87a39fba73be5a103"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/exact-head-authorization.mjs",
    "sha256": "f0de4d52eb305b39b81d9d2ea80654f3794c8ed5cc8df2c7af4e6abb93fd55ea"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/exact-head-checkout.mjs",
    "sha256": "954a02d88a24ce5aae7996a3d233b6ccf19e1848f84c2de2a42234730373956b"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/exact-head-supervisor.mjs",
    "sha256": "bb8a3179b7cc6884ce67382a0a7c0815710454b0bb4c28ca5266b942e7cd72cb"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/fixture-source-closure.mjs",
    "sha256": "38072c112e5e03b4eef58b37b70ce7af2c7cf98b3593ba679ef050d31cbc276d"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/fixture-templates.mjs",
    "sha256": "a494440a3dbec5fcc0ac9e56430a3c164e90a3da73b9906cce27f9edec57445a"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/mutation-controls.mjs",
    "sha256": "e381a4339d2635e39032489eb04455df42d5855bd63acfb67d4159baa95bc824"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/owned-files.mjs",
    "sha256": "abe8418534c1b10874d577bf2482bd59220a2fa3a7c2c56d01de8281e011b33a"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/partition.mjs",
    "sha256": "4747849958da5c477d2abef9b57a713a648c1c531a6a445fd9833e18a07f44c8"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/performance-cases.mjs",
    "sha256": "2a143c9395095a5f23240b65f6cfa9b20b0c5a7cc090e017323af29aa766f71d"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/performance-context.mjs",
    "sha256": "5e82591d55c44dd258b2f1cfc7ce8bac7570cbade2051ecec2791dd27a559d93"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/performance-material.mjs",
    "sha256": "9085b570cf36d7738f6462964820edf2b06b676dd64522beec94f37c26e58249"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/process-supervision.mjs",
    "sha256": "6413c84296d4642fee4df4e57b3ae77b761b1ea7f1fd49a95c1299d2bb31ee24"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/resource-parallel.mjs",
    "sha256": "ff0947a42ffab6298a22d8e6e45c59f2e19909f05b75f2ea161b1d89f7c9688b"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/resource-traces.mjs",
    "sha256": "34724d988cb031fd3719c1dc3e15af9403b9db38be822d927613a23f73aa8292"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/selection-contracts.mjs",
    "sha256": "6fe983d7a92f0dde1a0d904f89dece2492de23dfae5964ddb2b34516c3862714"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/selection.mjs",
    "sha256": "22e773ef1d8b218683f2c8b196361bd706acef446b7c65e4f0f3d91887f8eaa7"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/supervisor-controls.mjs",
    "sha256": "ee29f47ccdf5e933c7a39c04ab41d9306a77bc33c8465b4d7ec973732bda18ff"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/support.mjs",
    "sha256": "92fb19e38d83d10497256571ce730d88245419aec20a5065251187f88def8762"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/tree-lease.mjs",
    "sha256": "c2738d8b5d7dea654b9adbe37ce7407f67f03f6b943cde6e9f2b4b5bebf98957"
  },
  {
    "path": "packages/main/tests/red/quorum-submit-harness/worker-coordination.mjs",
    "sha256": "e39ede5009077779908a20fbea0db75057b831ef6872c986e5f34f7ef9c4f895"
  },
  {
    "path": "packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts",
    "sha256": "f745ed62b04de0a59596f418071e8fc0acd5392e9903820121e4c3609986bee4"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/binding-classification.ts",
    "sha256": "91c1ac5f4de58ed08e720fb7d0cd24403533511680b47f7db41c1e07f4f8b145"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/cli.ts",
    "sha256": "eb4414407f36bf43919066e1eb7d0baa8253d3439b4b65bf5e20dc86518ac2ca"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/compatibility-controls.ts",
    "sha256": "82db53da1f809f38e132112ddbf45655694d0d836312c1b29514503b5f256d44"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/driver.ts",
    "sha256": "773436acf17b29c3afb3deb3b30cb8f5d30ea63e562dc5a2821f76fbf0394565"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/dynamic-bindings.ts",
    "sha256": "fab86307a3e436dc5a8ecfe8dd3e5b7e32ef1525796f6eb5332fc7a0e151a78b"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/dynamic-scan.ts",
    "sha256": "9d5fca657e43fde333ba508c30109b2a4b611cf7b32fbf040ede96e8aa5699c9"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/execution-controls.ts",
    "sha256": "3b11ec24c4a59cc030d548c76c6724d3cbef1bfbfbfdd8bb7a36767a6fa25f63"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/file-scan.ts",
    "sha256": "8c3675be9d824bfe4cf7b6b312b3dc98f221fc472d9cd8d35cb52f78f57d764c"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/loader-controls.ts",
    "sha256": "f35936426105b82e369e39e95b64caaa672dc162023c3611a31bb761b5d6f651"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/module-loaders.ts",
    "sha256": "b4e04eac69a015b05849ed5510a0d4868499b26e9be23d96961b7452fffa61fc"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/positive-controls.ts",
    "sha256": "47299763ab4779280dd653655ca3021963a7fe8f2dcabf5bb75096b24aa0f6bb"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/public-contract.ts",
    "sha256": "fc11bcd12e14eae7e923dfc89df2398b17affb700117c906fc8ec581e8eca470"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/rule-data.ts",
    "sha256": "9a7bb5d52e6887d4627d007523f8947dd748d53f31f513cbb3fa8ea5d0740c47"
  },
  {
    "path": "packages/main/src/tasks/retired-authority/type-analysis.ts",
    "sha256": "d55546c20effc5b03f176c850cb22e193599ef734ad5b1edeeea8b9fec7780df"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner-smoke.ts",
    "sha256": "e0dcb78ea103f5e88c4f585e93471956afbfc5aad628cc47827276717f150f07"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/acceptance-guards.ts",
    "sha256": "25bf31beaf66efd2388277cdfeeb73d19f3371c20978370e18f71d0d7f5d2b4f"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/change-inputs.ts",
    "sha256": "e7aa8193d0225c0b351cb98f42db802dacb1d2a9c4d2e52b37f587c9170fd95a"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/cli-integration.ts",
    "sha256": "6cf67157c7bb9f5627699a66a0828301fad969f13b938ebe8b1418b9449e85f2"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/cli.ts",
    "sha256": "2df2213f4daeeceadd3363c1832d63a72e652dd5e8c74df12f8ef8be21c9b7ef"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/command-identity.ts",
    "sha256": "7079da7674cbe9900ad00e58b5cbdcdac6e5ed212529c19aa27adf2859b5bf0c"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/hash-completeness.ts",
    "sha256": "9c2ce9c5178bdf160c73c03dfbf74c899940ba6b5053486e081298de742d6575"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/historical-pins.ts",
    "sha256": "14e4b87544454b0628c5704d833e68c77bc5057b2bec02743c79be97d25fe953"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/selection-widening.ts",
    "sha256": "fae381294266e3ba36e9fa0414cd29fa1ee27be7287511c5b673167afa2c3e2a"
  },
  {
    "path": "packages/main/src/tasks/validation-tier-planner/support.ts",
    "sha256": "26f38fca470e41e55b4728b2031b365c725efc955a32294c6ddaaef045a9257d"
  },
  {
    "path": "packages/main/src/tasks/flow-stability-smoke.ts",
    "sha256": "46284bd584b730478bf67f5e500f105f1fe286be62aeb983f2edaa26caefc624"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/artifacts.ts",
    "sha256": "a05cf8216204c2f09dc8d5c90b9c814120d1b1bd3bc5e6b1825632d364f8c717"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/cli.ts",
    "sha256": "355887eba54b129fa71c020faab5678913d4ac0393a5e068264f2d4344b1711f"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/discovery-fixture.ts",
    "sha256": "eb08600955e4886eba1ab2e2bfd22c78b7d34c83364a13f7b5696b64bff1cf97"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/done-convergence.ts",
    "sha256": "27e1ec61092594df79453f40643fa8ed8ed4967a9f9c9e606baee9298618c784"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/done-reporting.ts",
    "sha256": "6fc3e3015d1585b272b01ad0ed35c3039f1df7f379a5ec376c73e64c9c7a26ed"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/lifecycle.ts",
    "sha256": "731cd06c1f369099742a83565cb3c641b13ed4026ffd5bfc9e6e2dca45a7d23c"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/phase-effects.ts",
    "sha256": "db3631d746746489533c2407f0b2d21cb03e3f7ed8cee82290f100a1143e24cb"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/review-evidence.ts",
    "sha256": "bd2a2d8883c82655cff85a3b797df6dbbed9915e5465059e52b0f3252ee4be1e"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/review-routing.ts",
    "sha256": "a3ad088da17bdf1abdd6ffeafd2186e413726441d66eee934f6ae1045e09390b"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/support.ts",
    "sha256": "5fadd8ffd3f0b964f0f4ce9d7b07f26e8d6ba7a7fd9eca7d35ce2a884d392e95"
  },
  {
    "path": "packages/main/src/tasks/flow-stability/workspace.ts",
    "sha256": "4ebf9339bdec52eaaf1e8b1c775d746c7bbb9ec234c635c1f4bbd30d52f0bc84"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "sha256": "e964f58c94197066257c16d71d611a75712d530b50cec23350b6539cac2bc0e3"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/artifact-inventory.mjs",
    "sha256": "1c234a048e37c6d6a04be9c98816ac8b5b0612d64bb739b3630649c3c8f3f89b"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/catalog.mjs",
    "sha256": "a02325c892938a4ae04421c4805d9bece569357e8f695f51c99f6f7b3a8085b9"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/cli.mjs",
    "sha256": "70387c9e0cba4f1222c11ad32843b302dc2498d03014ebcfb1835524e2d82deb"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/data.mjs",
    "sha256": "4dd0430ecdb574343b258f412d7519d74de9fc205d6e291c219921c1b9807430"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/driver.mjs",
    "sha256": "238ee9818e074337bdf6a7dcf2ec9c1e286c3da8ea7809fb259d3b6389e913c0"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/finding-artifacts.mjs",
    "sha256": "ba62e5b976a0966c0f54b7de7dd47299174b4ab3b6c229219b50d41c1f7323aa"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/fixture-support.mjs",
    "sha256": "d7906a28cf62d087c16d9ee4f43d953fb51393422e65f65967702ce9df859877"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs",
    "sha256": "c583bd41ee5789221e5f93f938f4528a9408dc376d72ef838260cc5e3236355b"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/identity-inventory.mjs",
    "sha256": "641c4ddb9a817b47e2cd93693316725d41c1ee7f820fba26f3f1505e090404b3"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/identity-ownership.mjs",
    "sha256": "22a8265456c3424f56709635195a3f66dc602230612ec2a8165a3d7e12d98f67"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/identity-policy.mjs",
    "sha256": "323875cf923559b5848f2d22973adf18f521d5d79ccef5671835b7162c4e447c"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/identity-runtime-boundaries.mjs",
    "sha256": "e01844f2aa0d34f4ed5ded22d8ff334ff9ec10a05179107cddb34759ae6a8d7c"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/identity-sites.mjs",
    "sha256": "010a15eda866aeddc9bd68935ee0d43b1bcdc02f80c7f4904d662795f076a6d2"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/memory-runtime.mjs",
    "sha256": "4dc9b24ef3b263c169bf9b54d9e24a69925147104dc2224f23d0e914b86f7a96"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/migration-archive.mjs",
    "sha256": "912b536c8dbd9834c32934782950f4b97a1742a193df75aeb8fb47f0a95093ce"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/public-fixtures.mjs",
    "sha256": "f5ce04dbadba9d797ba1488796fbacce9b37cbd305fce94d9e3439097582aeb2"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/release.mjs",
    "sha256": "1775bb8364f09d2a732d22f4ad582d7d085ca762accf27a7928e8bffc74003e7"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/runner.mjs",
    "sha256": "3a7270ee39b9dc7658429d9538351c96e9d1cfd4eb5507c9d394c7f7aa5c88bb"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/runtime-extensions.mjs",
    "sha256": "fc507afda2de106bb6a3036962bf7adf29aabf78edc3f456390364f5e88f17d1"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/runtime-read.mjs",
    "sha256": "e154a98b7fa6bbd63e7730f1bf3f9921f8c84608591288ba747ab827b8611285"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/runtime-topology.mjs",
    "sha256": "4d08bd149558036b3c18de20dbe715ebdb058cbbb1bee36d3b87f1bf342e2647"
  },
  {
    "path": "packages/main/tests/canonical-new-story-artifacts/scope-init.mjs",
    "sha256": "0233ab0985da1e2b928ee74264167120e368c97c4d340cf31f9b3b74330bb848"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime-smoke.ts",
    "sha256": "5a7a6018c06f541c8757c16385537a09985f6461e7b0a00b4d70a94c38a06cf4"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/authority.ts",
    "sha256": "09b7f7d790053c50d6cd8495a10ee0d42bcb1f749c57b4d6af7438f408a15c17"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/boundaries.ts",
    "sha256": "4bf5ff980f301973eac59b0a418288083dfb708cf7f76e9eeeb9fd7164ccd928"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/cli.ts",
    "sha256": "4d0aaf426d46f85b68e8f2a87a4ba339d378ab31ec1c28c91489c9bd68c896c1"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/distribution.ts",
    "sha256": "a38e7b7cf006d4c829cb2b1105ed8995ba3cbce09d358044eb9fda5a751fca56"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/process-mutation-proof.ts",
    "sha256": "7a6e13957754cc1edc350439f8d0868eb5278f4535a4f81e8fd209fcb34de0b0"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/projection.ts",
    "sha256": "d42744f5b3eb89db28d5a667f4ceb13d825853065ba63174576ae493a88a4526"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/runtime-evidence.ts",
    "sha256": "78190792b2a9867a41317bb818dfbc88b87503b10982c5e66636a4cafa72ee44"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/support.ts",
    "sha256": "aa986bc3c6dbdfe4c71cfc78d6eaec49d6778a695beae1bfd288efc64637c985"
  },
  {
    "path": "packages/main/src/tasks/finding-ledger-runtime/transactions.ts",
    "sha256": "384643cac57741394881dab669c9decf11e958a37d5358c1b1ec7fd7ca746111"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence-smoke.ts",
    "sha256": "0061e78e4c40a3edbb0135653bf877e66aab3ecdba771fb5e7784b9fd5e9878d"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/claude-transport.ts",
    "sha256": "54510c570ae14e0e1e0262c3d8e77387e158d163f7e172d40300769c5650ce21"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/cli.ts",
    "sha256": "f3070ab1fded0a090528d095edd32cae594c4f53bcb0d88b37226102ad4e3550"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/codex-transport.ts",
    "sha256": "9707487b1e14054e42d727d89795d9f832cd496883c70deca0c7fb8563c10d35"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/environment.ts",
    "sha256": "e13324de950441f8e7658f809ee7bfc074f49e00cb9f6e9e54f32b7df572d205"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/evidence-binding.ts",
    "sha256": "8a5c270530b7203f15ee71865d8f188b41b7d84c4b2459575533af3a6a9a7c76"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/fixtures.ts",
    "sha256": "4a6b8ef5812dfd7bf80d0ec5c2476db342e00cd0aca246fd58c7eb0e148e926e"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/grok-integration.ts",
    "sha256": "8b58cde57418ea7383974c39c43c73e3ec6dd34ad967ad629e5ab0d2a0794518"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/legacy-cli.ts",
    "sha256": "4cb7da4fb380006a86fbb01b41853f38b6059507161243b7e5761d06b1f25fb7"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/live-binding.ts",
    "sha256": "11959f2b212a09f7f76422368e1c1c17439e79e3a4cfd72ed9d4b6776ea2deb9"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/native-attestation.ts",
    "sha256": "743994f62d3162173d65fd819750088be9f594f07fd7a63bfe938d98a4a142d9"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/prompt-fixture.ts",
    "sha256": "73b99b7743364a6f310774f21763d010e20380ff80188eea2f0f1b4d83071a8a"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/sealed-receipts.ts",
    "sha256": "e4b96e725fb5906fbddadc873719022220b0d241efbd49c312aedc45a4183b24"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/suite.ts",
    "sha256": "9fb895a0b8efca91595a785d40c50014594d0aad53d4d8bc05e8a4283a9013da"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/supersession.ts",
    "sha256": "ff2654e5bf0f6a0072f7dac48a889000bc71e412dc62ba795804f5dd69afdf15"
  },
  {
    "path": "packages/main/src/tasks/managed-review-evidence/transport-workers.ts",
    "sha256": "ecbac7a51fc2aedc4ce6ec98845b7ca8336689b29a7ad786153d4f6ee199202c"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage-smoke.ts",
    "sha256": "bd4c0381f2c15ec3dc5085e68cfc75f6e4160cf79bb0d24f226f0dc3321ccca9"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/admission.ts",
    "sha256": "3e96df901b20790aebdc5b1faab374fa09550e89cd8f8ad6198d41f59672de2a"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/cli.ts",
    "sha256": "a93741aacc27b895c35cd903605451301a2faf50ec1838dd2375f4b0f7725097"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/evidence-mapping.ts",
    "sha256": "9d51435919504df525e44d281e13f72cd76ecb354010acaf6dd50efe5183eca7"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/integrations.ts",
    "sha256": "f0d001232225a04526717f8c53193cbdb72b1bf15058e2bc308d8aac1962935e"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/ledger-concurrency.ts",
    "sha256": "4de0a6e85cdcddbac8d20f1819e95509a992c665f802c12c34f5f39876753f23"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/ledger-failures.ts",
    "sha256": "bdf7bde024315604b501ecc2f9f514b381f8099ef1060574da6d276bd813b148"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/output-errors.ts",
    "sha256": "a767810d48b5286842c593d2356f0c6511882d2411c36b462ddc53a2de255c32"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/process-supervision.ts",
    "sha256": "78b2cbf5943235f764d9ae782300896ffa49a0dd8db8cf9ceddec305990e47fa"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/prompt-supervision.ts",
    "sha256": "4aede3132ca3d1d438a45ae3e389ebfd439e482957f5bbf7d99023c923cdd587"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/proposal.ts",
    "sha256": "ece4f239fa02b3229cad6f295572c56f15c20339ddb8e910da046c5df0b45941"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/story-binding.ts",
    "sha256": "6bff02ae7c2053a984d6c277f2538c3e2e3aea65f46b3f21990a1fb64e704519"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/streaming.ts",
    "sha256": "e3756cdd967f9f37c8fb3a73b03af8f9091d53a92e332bfc6c4a1487a013ad58"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/summary.ts",
    "sha256": "96997eb75f95dc2811184d4a30a4c56e26967c167104b4eba2d6633074665beb"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/support.ts",
    "sha256": "eceab4894a349c3d444c47e4f648b52e0fa2c92ff95dd3c11bc60b64a4f580f0"
  },
  {
    "path": "packages/main/src/tasks/host-run-usage/usage-parsing.ts",
    "sha256": "d07e18874ce63ee73d40f48e18b793c50e24a9713b17df9e6581ecbcfda0297c"
  },
  {
    "path": "scripts/verify-proof-or-stop-prompt-baseline.mjs",
    "sha256": "d3fe4c7fa9be7360969059a70782e28518f21fe11d60953a8d5658466749866d"
  },
  {
    "path": "scripts/prompt-baseline/cli.mjs",
    "sha256": "b6bf89ef92fa45a25ce133cdc6fabc26a53c0304a31b2fd02009be3ff9ff4980"
  },
  {
    "path": "scripts/prompt-baseline/collection.mjs",
    "sha256": "d1eb453b668b3c58c725ab0bb848634131df93d73361ba021139f397c8cd1a1d"
  },
  {
    "path": "scripts/prompt-baseline/policy-data.mjs",
    "sha256": "d2b264b29ab9c41af47e2aebf9d73a18341ef6425fcfedf8601987311d5e1dd2"
  },
  {
    "path": "scripts/prompt-baseline/policy-probes.mjs",
    "sha256": "4f3fa2a4ab3141dd6e587dc077e30fdc7f0a8508680491354ae702872f35b719"
  },
  {
    "path": "scripts/prompt-baseline/scanners.mjs",
    "sha256": "10570c996321b1a96311daf3b6b033f668bf7f58462100f0dccc4eed0b978c6b"
  },
  {
    "path": "scripts/prompt-baseline/verification.mjs",
    "sha256": "9dfbb755c8b67cf294f39e17903510efb38b7b506e5333692b121a2fc955b0f6"
  },
  {
    "path": "packages/main/tests/milestone-status.test.mjs",
    "sha256": "407bf57ccd5f70882193454097a8b0983c0d96236077f10aad1d5f43c0fcb039"
  },
  {
    "path": "packages/main/tests/milestone-status/cli-behavior.mjs",
    "sha256": "5a0d219bf4b4dbfcba8c75e04f2a113d316bbea16a0d6ee7713c34715f423374"
  },
  {
    "path": "packages/main/tests/milestone-status/cli.mjs",
    "sha256": "94a5aee13fc85e4b6e0a5cd34707ed68abc2639e3fb8cd5b1fbd9a6f6d0a2611"
  },
  {
    "path": "packages/main/tests/milestone-status/closeout.mjs",
    "sha256": "7d660a78096ba1fb1a803e78be2e483ff84419ca35313b1fb75560f326d4e0f5"
  },
  {
    "path": "packages/main/tests/milestone-status/coverage.mjs",
    "sha256": "28934a4286fb791c0a5a6b90e3d344385679ca97a02584a126442142e6896a24"
  },
  {
    "path": "packages/main/tests/milestone-status/freshness.mjs",
    "sha256": "c3640eb1e89fb9c190772b308951afaa73d83b21477059e1923731c7dbc320a3"
  },
  {
    "path": "packages/main/tests/milestone-status/planning.mjs",
    "sha256": "c0459dfda5c3f74da47641b9bbb0487ec6c3eb69db7a5cf022fe899a23ec8380"
  },
  {
    "path": "packages/main/tests/milestone-status/read-only.mjs",
    "sha256": "3044c294fc781b8cdeb3bb75b302fa57a04a2696d1688e900e4a01147480fc46"
  },
  {
    "path": "packages/main/tests/milestone-status/reporting.mjs",
    "sha256": "c17ceb7d832069d7fb07a086364d2e279343033a09bfe568f4ec1bf61621fc67"
  },
  {
    "path": "packages/main/tests/milestone-status/support.mjs",
    "sha256": "769bcaf9548cc61ab296d0d3d8dc0d2124b31a765aa78cfa73e9accb4d59bd99"
  },
  {
    "path": "scripts/verify-validation-build-artifact-binding.mjs",
    "sha256": "b57828732bbbcba5888e85cf5447c7fd628ddb00281bec3ca09c0081ce876c69"
  },
  {
    "path": "scripts/validation-build-binding/cli.mjs",
    "sha256": "05f7fcf2189f833d4213f0e4251bfe9d9133b10e3e1cbb72906dc121560e91ad"
  },
  {
    "path": "scripts/validation-build-binding/done-required.mjs",
    "sha256": "7b6be49b8e8e92cfb35fce9b9661093efb708cc37ad28f3772d9a69eeb5acfba"
  },
  {
    "path": "scripts/validation-build-binding/executor.mjs",
    "sha256": "2eefd692965ed9652cfb16201e861b83b7e494204b0b04407003081c97e3af2c"
  },
  {
    "path": "scripts/validation-build-binding/handler.mjs",
    "sha256": "3a9c7a6103c668e9f06fe65c62552c8ca24d393a7614fc3e6425e10b8434d2cc"
  },
  {
    "path": "scripts/validation-build-binding/routine.mjs",
    "sha256": "ed29329beac71a968f9da210a0bdea85286a7c2ac52bab70fc5aa529546614c7"
  },
  {
    "path": "scripts/validation-build-binding/shared-cache.mjs",
    "sha256": "8619e4e9a311943b082c2d2c5eb89cafd9762736f765fc13d71d1fa9a4a4b753"
  },
  {
    "path": "scripts/validation-build-binding/support.mjs",
    "sha256": "8bc03b1f51c4bb86bd865a6e0dea6e819a8d99c4a25263c0414453a12a8189c7"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard-smoke.ts",
    "sha256": "a123928aa8ea73e9f58ee266e771dc29dfc77b1410c7ff2e9b359ae0f8756fac"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/causal.ts",
    "sha256": "4f0ed6fda17abc9062dbbf259d36ccbc5ff157df2cbac73118cc99faa7866316"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/cli.ts",
    "sha256": "b1f534230213aea03bc106a20aa3242c906484983f959a9b1d6c908b20f86257"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/foundation.ts",
    "sha256": "3825f4bd40ba7bfdfe5ab9652859cab85fbd9935b10b0b6007c14f59547d12b7"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/integrity.ts",
    "sha256": "c78157212d0e64d914f2929ffb86eadd802a63b89c87688caf724a8bc13f9076"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/publication.ts",
    "sha256": "eae116595c99c8a8f97bbb63dbbbc3828b9af6c06dd3956bcfd09401694f7ddf"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/refresh.ts",
    "sha256": "535d27bea6ef10e1a699297b50fd7a4938b9c70461684bc825da2d2d00d7d15e"
  },
  {
    "path": "packages/main/src/tasks/verification-run-and-guard/support.ts",
    "sha256": "148aa837b600de613e73a6eff7ef49d8fcc67e99f7562cb0a12265f886356caa"
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
  ["proofbound.product-capability-release.v1",12,"ab23c21457dbefd2162a7431a5a0ddaee6e6e30a3212dd71c76f1827bcecf70f"],
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
  ["packages/main/tests/canonical-new-story-artifacts/identity-inventory.mjs","// this inventory specifically so active proofbound protocol literals or",1,"360530bd2123c42ef12c5ce94b715cecb9b3f19152573bc4da4e6b89fe127230","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs",", 'CHK-007:edge:0 frozen proofbound history stays byte-identical and is rejected by active readers', () =>",1,"ac46d7f5af2afc2060115d73d97e493dfb87017ebf218029cc4ff253165ef283","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs",", 'CHK-007:adversarial:0 proofbound injection at every active boundary fails closed with zero mutation', () =>",1,"5faf7bdaaf63f9f8b46c2640d3b6fdf5c97001d7fb7454badd7315aad8b35e34","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
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
  ["packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs","/retired|proofbound|unsupported|unexpected|pinned|provenance|allowlist/i,",1,"ac899cff98f276f54bda8c39e62eac61881cf45ac8ea24dd2025ded8015a7ab2","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs","/retired|proofbound|unsupported|unexpected|allowlist|schema/is,",1,"62d0b0b5c4eb59006d2c4a5bb5584f6b8aeb88efa85627c64151a95f11f44e4f","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/identity-sites.mjs","assert.equal(/proofbound/iu.test(readFileSync(join(repoRoot, path), 'utf8')), false, `$",1,"7eef367f9b5eb038c73b01cfb659f24b339e41dde992e3fda28150d7f88a52f8","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/identity-sites.mjs","assert.equal(/proofbound/iu.test(bytes), false, `$",1,"97b2e85d00c912d1dbada8741102737d5c26b412f7f11f5648736e8bc859c03f","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/migration-archive.mjs","assert.ok(identityCase.retired.startsWith('proofbound.') || identityCase.retired.startsWith('proofbound-'), `$",1,"a5d6d90f0f359d936965876c05c9f88954ed38e86b9a089c8ef344b32bc6c9b7","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
  ["packages/main/tests/canonical-new-story-artifacts/migration-archive.mjs","'proofbound-'",1,"a5d6d90f0f359d936965876c05c9f88954ed38e86b9a089c8ef344b32bc6c9b7","compatibility_fixture","Exact retired-input rejection or error/transcript fixture; never a current identity producer or alias authority."],
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
  [4,"641c4ddb9a817b47e2cd93693316725d41c1ee7f820fba26f3f1505e090404b3"],
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
  [52,"32c50661e5df14c86ebd3e045016b3faddcf6f7e91c20156cb7c08819100a05f"],
  [55,"0a0e8086be494cbf378b488a2d891a43db5559f077042ac6da87cfd4a90375d0"],
  [60,"bb56479da5c58cf6baccddf3cbde7255e82c0e0fd805acc6a412ffee6a728758"],
  [62,"9ee8a71dcfaacfc632a7756be28b1ade7039a97650843eb0389591d0747c44ca"],
  [63,"2c66ecdd669663680f3ec141617a929b29ae53ca6a603f1d6a31197dfdcd4be4"],
  [71,"64d8b8595ea8803596857eafe06b9f95a212ed86978ca4407748ebbac680ce30"],
  [72,"bba76d9fccb473fe801af115aad9eb59c82f382d0934a14f69cfce860d0c376f"],
  [73,"42de93915352c14e2962c733365adfd1c840a9b12cce78bf4bcfa201676a6870"],
  [74,"e5259450c31aa3feeaaebcb83fa32adc5f171019564c121d10cb87889c1e584d"],
  [5,"c583bd41ee5789221e5f93f938f4528a9408dc376d72ef838260cc5e3236355b"],
  [67,"010a15eda866aeddc9bd68935ee0d43b1bcdc02f80c7f4904d662795f076a6d2"],
  [69,"912b536c8dbd9834c32934782950f4b97a1742a193df75aeb8fb47f0a95093ce"]
].map(([rowIndex, sha256]) => ({ path: BOTH_FAMILY_CONTEXT_ROWS[rowIndex].path, sha256 }));

export const MODULAR_WITNESS_CLOSURES = {
  "scripts/verify-process-fact-contract.mjs": [
    "scripts/verify-process-fact-contract.mjs",
    "scripts/process-fact-contract/catalog.mjs",
    "scripts/process-fact-contract/cli.mjs",
    "scripts/process-fact-contract/command-contracts.mjs",
    "scripts/process-fact-contract/complete.mjs",
    "scripts/process-fact-contract/early.mjs",
    "scripts/process-fact-contract/prompt-contracts.mjs",
    "scripts/process-fact-contract/proofstory-closeout.mjs",
    "scripts/process-fact-contract/registry-alignment.mjs",
    "scripts/process-fact-contract/registry-parser.mjs",
    "scripts/process-fact-contract/reopen.mjs",
    "scripts/process-fact-contract/review-inventory.mjs",
    "scripts/process-fact-contract/review-verification.mjs",
    "scripts/process-fact-contract/scope-runtime.mjs",
    "scripts/process-fact-contract/source-analysis.mjs",
    "scripts/process-fact-contract/story3.mjs",
    "scripts/process-fact-contract/support.mjs"
  ],
  "packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs": [
    "packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs",
    "packages/main/tests/red/quorum-submit-harness/callback-inventory.mjs",
    "packages/main/tests/red/quorum-submit-harness/catalog.mjs",
    "packages/main/tests/red/quorum-submit-harness/cli.mjs",
    "packages/main/tests/red/quorum-submit-harness/containment.mjs",
    "packages/main/tests/red/quorum-submit-harness/coordinator-wiring.mjs",
    "packages/main/tests/red/quorum-submit-harness/driver.mjs",
    "packages/main/tests/red/quorum-submit-harness/environment-closure.mjs",
    "packages/main/tests/red/quorum-submit-harness/exact-head-authorization.mjs",
    "packages/main/tests/red/quorum-submit-harness/exact-head-checkout.mjs",
    "packages/main/tests/red/quorum-submit-harness/exact-head-supervisor.mjs",
    "packages/main/tests/red/quorum-submit-harness/fixture-source-closure.mjs",
    "packages/main/tests/red/quorum-submit-harness/fixture-templates.mjs",
    "packages/main/tests/red/quorum-submit-harness/mutation-controls.mjs",
    "packages/main/tests/red/quorum-submit-harness/owned-files.mjs",
    "packages/main/tests/red/quorum-submit-harness/partition.mjs",
    "packages/main/tests/red/quorum-submit-harness/performance-cases.mjs",
    "packages/main/tests/red/quorum-submit-harness/performance-context.mjs",
    "packages/main/tests/red/quorum-submit-harness/performance-material.mjs",
    "packages/main/tests/red/quorum-submit-harness/process-supervision.mjs",
    "packages/main/tests/red/quorum-submit-harness/resource-parallel.mjs",
    "packages/main/tests/red/quorum-submit-harness/resource-traces.mjs",
    "packages/main/tests/red/quorum-submit-harness/selection-contracts.mjs",
    "packages/main/tests/red/quorum-submit-harness/selection.mjs",
    "packages/main/tests/red/quorum-submit-harness/supervisor-controls.mjs",
    "packages/main/tests/red/quorum-submit-harness/support.mjs",
    "packages/main/tests/red/quorum-submit-harness/tree-lease.mjs",
    "packages/main/tests/red/quorum-submit-harness/worker-coordination.mjs"
  ],
  "packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts": [
    "packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts",
    "packages/main/src/tasks/retired-authority/binding-classification.ts",
    "packages/main/src/tasks/retired-authority/cli.ts",
    "packages/main/src/tasks/retired-authority/compatibility-controls.ts",
    "packages/main/src/tasks/retired-authority/driver.ts",
    "packages/main/src/tasks/retired-authority/dynamic-bindings.ts",
    "packages/main/src/tasks/retired-authority/dynamic-scan.ts",
    "packages/main/src/tasks/retired-authority/execution-controls.ts",
    "packages/main/src/tasks/retired-authority/file-scan.ts",
    "packages/main/src/tasks/retired-authority/loader-controls.ts",
    "packages/main/src/tasks/retired-authority/module-loaders.ts",
    "packages/main/src/tasks/retired-authority/positive-controls.ts",
    "packages/main/src/tasks/retired-authority/public-contract.ts",
    "packages/main/src/tasks/retired-authority/rule-data.ts",
    "packages/main/src/tasks/retired-authority/type-analysis.ts"
  ],
  "packages/main/src/tasks/validation-tier-planner-smoke.ts": [
    "packages/main/src/tasks/validation-tier-planner-smoke.ts",
    "packages/main/src/tasks/validation-tier-planner/acceptance-guards.ts",
    "packages/main/src/tasks/validation-tier-planner/change-inputs.ts",
    "packages/main/src/tasks/validation-tier-planner/cli-integration.ts",
    "packages/main/src/tasks/validation-tier-planner/cli.ts",
    "packages/main/src/tasks/validation-tier-planner/command-identity.ts",
    "packages/main/src/tasks/validation-tier-planner/hash-completeness.ts",
    "packages/main/src/tasks/validation-tier-planner/historical-pins.ts",
    "packages/main/src/tasks/validation-tier-planner/selection-widening.ts",
    "packages/main/src/tasks/validation-tier-planner/support.ts"
  ],
  "packages/main/src/tasks/flow-stability-smoke.ts": [
    "packages/main/src/tasks/flow-stability-smoke.ts",
    "packages/main/src/tasks/flow-stability/artifacts.ts",
    "packages/main/src/tasks/flow-stability/cli.ts",
    "packages/main/src/tasks/flow-stability/discovery-fixture.ts",
    "packages/main/src/tasks/flow-stability/done-convergence.ts",
    "packages/main/src/tasks/flow-stability/done-reporting.ts",
    "packages/main/src/tasks/flow-stability/lifecycle.ts",
    "packages/main/src/tasks/flow-stability/phase-effects.ts",
    "packages/main/src/tasks/flow-stability/review-evidence.ts",
    "packages/main/src/tasks/flow-stability/review-routing.ts",
    "packages/main/src/tasks/flow-stability/support.ts",
    "packages/main/src/tasks/flow-stability/workspace.ts"
  ],
  "packages/main/tests/canonical-new-story-artifacts.test.mjs": [
    "packages/main/tests/canonical-new-story-artifacts.test.mjs",
    "packages/main/tests/canonical-new-story-artifacts/artifact-inventory.mjs",
    "packages/main/tests/canonical-new-story-artifacts/catalog.mjs",
    "packages/main/tests/canonical-new-story-artifacts/cli.mjs",
    "packages/main/tests/canonical-new-story-artifacts/data.mjs",
    "packages/main/tests/canonical-new-story-artifacts/driver.mjs",
    "packages/main/tests/canonical-new-story-artifacts/finding-artifacts.mjs",
    "packages/main/tests/canonical-new-story-artifacts/fixture-support.mjs",
    "packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs",
    "packages/main/tests/canonical-new-story-artifacts/identity-inventory.mjs",
    "packages/main/tests/canonical-new-story-artifacts/identity-ownership.mjs",
    "packages/main/tests/canonical-new-story-artifacts/identity-policy.mjs",
    "packages/main/tests/canonical-new-story-artifacts/identity-runtime-boundaries.mjs",
    "packages/main/tests/canonical-new-story-artifacts/identity-sites.mjs",
    "packages/main/tests/canonical-new-story-artifacts/memory-runtime.mjs",
    "packages/main/tests/canonical-new-story-artifacts/migration-archive.mjs",
    "packages/main/tests/canonical-new-story-artifacts/public-fixtures.mjs",
    "packages/main/tests/canonical-new-story-artifacts/release.mjs",
    "packages/main/tests/canonical-new-story-artifacts/runner.mjs",
    "packages/main/tests/canonical-new-story-artifacts/runtime-extensions.mjs",
    "packages/main/tests/canonical-new-story-artifacts/runtime-read.mjs",
    "packages/main/tests/canonical-new-story-artifacts/runtime-topology.mjs",
    "packages/main/tests/canonical-new-story-artifacts/scope-init.mjs"
  ],
  "packages/main/src/tasks/finding-ledger-runtime-smoke.ts": [
    "packages/main/src/tasks/finding-ledger-runtime-smoke.ts",
    "packages/main/src/tasks/finding-ledger-runtime/authority.ts",
    "packages/main/src/tasks/finding-ledger-runtime/boundaries.ts",
    "packages/main/src/tasks/finding-ledger-runtime/cli.ts",
    "packages/main/src/tasks/finding-ledger-runtime/distribution.ts",
    "packages/main/src/tasks/finding-ledger-runtime/process-mutation-proof.ts",
    "packages/main/src/tasks/finding-ledger-runtime/projection.ts",
    "packages/main/src/tasks/finding-ledger-runtime/runtime-evidence.ts",
    "packages/main/src/tasks/finding-ledger-runtime/support.ts",
    "packages/main/src/tasks/finding-ledger-runtime/transactions.ts"
  ],
  "packages/main/src/tasks/managed-review-evidence-smoke.ts": [
    "packages/main/src/tasks/managed-review-evidence-smoke.ts",
    "packages/main/src/tasks/managed-review-evidence/claude-transport.ts",
    "packages/main/src/tasks/managed-review-evidence/cli.ts",
    "packages/main/src/tasks/managed-review-evidence/codex-transport.ts",
    "packages/main/src/tasks/managed-review-evidence/environment.ts",
    "packages/main/src/tasks/managed-review-evidence/evidence-binding.ts",
    "packages/main/src/tasks/managed-review-evidence/fixtures.ts",
    "packages/main/src/tasks/managed-review-evidence/grok-integration.ts",
    "packages/main/src/tasks/managed-review-evidence/legacy-cli.ts",
    "packages/main/src/tasks/managed-review-evidence/live-binding.ts",
    "packages/main/src/tasks/managed-review-evidence/native-attestation.ts",
    "packages/main/src/tasks/managed-review-evidence/prompt-fixture.ts",
    "packages/main/src/tasks/managed-review-evidence/sealed-receipts.ts",
    "packages/main/src/tasks/managed-review-evidence/suite.ts",
    "packages/main/src/tasks/managed-review-evidence/supersession.ts",
    "packages/main/src/tasks/managed-review-evidence/transport-workers.ts"
  ],
  "packages/main/src/tasks/host-run-usage-smoke.ts": [
    "packages/main/src/tasks/host-run-usage-smoke.ts",
    "packages/main/src/tasks/host-run-usage/admission.ts",
    "packages/main/src/tasks/host-run-usage/cli.ts",
    "packages/main/src/tasks/host-run-usage/evidence-mapping.ts",
    "packages/main/src/tasks/host-run-usage/integrations.ts",
    "packages/main/src/tasks/host-run-usage/ledger-concurrency.ts",
    "packages/main/src/tasks/host-run-usage/ledger-failures.ts",
    "packages/main/src/tasks/host-run-usage/output-errors.ts",
    "packages/main/src/tasks/host-run-usage/process-supervision.ts",
    "packages/main/src/tasks/host-run-usage/prompt-supervision.ts",
    "packages/main/src/tasks/host-run-usage/proposal.ts",
    "packages/main/src/tasks/host-run-usage/story-binding.ts",
    "packages/main/src/tasks/host-run-usage/streaming.ts",
    "packages/main/src/tasks/host-run-usage/summary.ts",
    "packages/main/src/tasks/host-run-usage/support.ts",
    "packages/main/src/tasks/host-run-usage/usage-parsing.ts"
  ],
  "scripts/verify-proof-or-stop-prompt-baseline.mjs": [
    "scripts/verify-proof-or-stop-prompt-baseline.mjs",
    "scripts/prompt-baseline/cli.mjs",
    "scripts/prompt-baseline/collection.mjs",
    "scripts/prompt-baseline/policy-data.mjs",
    "scripts/prompt-baseline/policy-probes.mjs",
    "scripts/prompt-baseline/scanners.mjs",
    "scripts/prompt-baseline/verification.mjs"
  ],
  "packages/main/tests/milestone-status.test.mjs": [
    "packages/main/tests/milestone-status.test.mjs",
    "packages/main/tests/milestone-status/cli-behavior.mjs",
    "packages/main/tests/milestone-status/cli.mjs",
    "packages/main/tests/milestone-status/closeout.mjs",
    "packages/main/tests/milestone-status/coverage.mjs",
    "packages/main/tests/milestone-status/freshness.mjs",
    "packages/main/tests/milestone-status/planning.mjs",
    "packages/main/tests/milestone-status/read-only.mjs",
    "packages/main/tests/milestone-status/reporting.mjs",
    "packages/main/tests/milestone-status/support.mjs"
  ],
  "scripts/verify-validation-build-artifact-binding.mjs": [
    "scripts/verify-validation-build-artifact-binding.mjs",
    "scripts/validation-build-binding/cli.mjs",
    "scripts/validation-build-binding/done-required.mjs",
    "scripts/validation-build-binding/executor.mjs",
    "scripts/validation-build-binding/handler.mjs",
    "scripts/validation-build-binding/routine.mjs",
    "scripts/validation-build-binding/shared-cache.mjs",
    "scripts/validation-build-binding/support.mjs"
  ],
  "packages/main/src/tasks/verification-run-and-guard-smoke.ts": [
    "packages/main/src/tasks/verification-run-and-guard-smoke.ts",
    "packages/main/src/tasks/verification-run-and-guard/causal.ts",
    "packages/main/src/tasks/verification-run-and-guard/cli.ts",
    "packages/main/src/tasks/verification-run-and-guard/foundation.ts",
    "packages/main/src/tasks/verification-run-and-guard/integrity.ts",
    "packages/main/src/tasks/verification-run-and-guard/publication.ts",
    "packages/main/src/tasks/verification-run-and-guard/refresh.ts",
    "packages/main/src/tasks/verification-run-and-guard/support.ts"
  ]
};
