# B-0692 Plan

## CHK-001

Create a code-level process fact level registry that classifies every MAIN_TOOLS CLI command plus a few named runtime behaviors. The registry will define L0-L4 in code, require command/category/owner/rationale, and reserve L4 for facts actually consumed by lifecycle gates. The visible outcome is that the contract output lists commands with levels instead of hiding that knowledge in script-local sets.

## CHK-002

Refactor scripts/verify-process-fact-contract.mjs so command coverage comes from the registry. Keep existing prompt drift, pass-only finding_add, legacy category, unknown category, and synthetic adversarial checks. Add registry-specific checks: every CLI command must be classified, duplicate commands fail, process-fact candidate commands cannot be L0, L4 entries must declare gateConsumer, and synthetic surprise_check_set fails when absent.

## CHK-003

Represent known soft spots as named runtime behavior entries rather than pretending they are gate-level guarantees. Include phase_tools_malformed_allow_all, test_auto_recursive_skip, and validate_fallback_discovery with rationale and non-L4 levels. Add contract assertions that these entries are present and printed, while L4 remains reserved for actual gate-consumed facts.

## Verification

Run npm run test:process-fact-contract and npm run build. If Codex adapter files are untouched, verify_codex is not required. Record verification evidence per checklist item after the commands pass.
