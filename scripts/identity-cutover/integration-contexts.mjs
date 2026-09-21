














export function mainIntegrationNegativeContextRows() {
  return [
    ["packages/main/tests/global-core-realpath.test.mjs","writeRepresentativeWindowsShim(join(resolverBin, 'lattice.cmd'), globalRoot);",1,"ae23682f05bf6f5b9a10c744e1d23dfdd3f7b1265223cbcfd84ecf4eaaf76e7d"],
    ["packages/main/tests/global-core-realpath.test.mjs","assert.notEqual(legacyOnly.globalCoreRealpath.status, 'pass', 'a legacy lattice launcher cannot mask absence of the canonical command');",1,"f3acc14b6023258ab5338bb5405d16cc324ce98c7faa36dd30cc95e355739662"],
    ["packages/main/tests/global-core-realpath.test.mjs","const legacyPosix = join(resolverBin, 'lattice');",1,"5b880a4c76701ac6ab7907b4e6d24e4cc2edddef19647ad966e6e444c096978e"],
    ["packages/main/tests/global-core-realpath.test.mjs","assert.notEqual(legacyOnlyPosix.globalCoreRealpath.status, 'pass', 'a POSIX lattice executable cannot mask absence of proof-or-stop');",1,"ea6f9211829e7183cb0bfd38d78b8633790aa98c44820149fb94401a011bd017"],
    ["packages/main/src/tasks/proofstory-pre-review-check-smoke.ts","LATTICE_ACTIVE_STORY_ID: undefined",1,"326a44eeb0714fb839f8b4f384a7e7923773321c0a8c1d1ec697718a0c864f9d"],
    ["packages/main/src/tasks/proofstory-pre-review-check-smoke.ts","LATTICE_ACTIVE_STORY_ID: 'B-legacy'",3,"bd4531a5e9132f99370ab83b2286016bc6ec10b36cb4ea6b7ac722f3004c2879"],
    ["packages/main/src/core/runtime-environment-checks.ts","// legacy `lattice` launcher cannot stand in for an absent `proof-or-stop`.",1,"dd2d74eb3f835e37c0e8aa1bd65dcecf7fa2b79528c3913b4000cf91082370c3"],
  ].map(([path, token, expectedOccurrences, contextSha256], index) => ({
    id: `main-launcher-negative-context-${index + 1}`, class: 'compatibility_fixture',
    path, token, expectedOccurrences, contextSha256,
    reason: 'Exact current canonical-absence rejection control or accompanying deny-only comment; retained old input never grants active identity admission.',
    disposition: 'frozen', verificationCommand: 'internal:verify-exact-frozen-occurrence',
    expectedVerification: 'PASS exact reviewed negative occurrence and bounded context',
  }));
}
