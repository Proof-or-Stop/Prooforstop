# PLAN — scoring-checks layer: harness-owned acceptance + hidden-regression + diff-hygiene (B-ebbb)

## Overview
Pure deterministic checks.mjs (3 checks) + offline unit test, per pre-reg 4.1/2/7. Exact section-7
field names: acceptancePass, hiddenRegressionPass, diffHygienePass.

## CHK-001
checks.mjs: harness-owned acceptance wrapper — verify the acceptance-script content hash equals the
frozen expected hash, run it from a harness-owned path (NOT the agent-editable workspace) against the
artifact; return {acceptancePass, scriptHash, hashOk}.

## CHK-002
checks.mjs: hidden-regression check — hiddenRegressionPass = no NEW failing tests vs the frozen
baseline snapshot (post-state failing set minus baseline failing set is empty); return
{hiddenRegressionPass, newFailures}.

## CHK-003
checks.mjs: diff-hygiene check — diffHygienePass = change confined to allowed paths with no
junk/forbidden artifacts; return {diffHygienePass, violations}.

## CHK-004
checks.mjs uses the exact section-7 field names acceptancePass, hiddenRegressionPass, diffHygienePass.

## CHK-005
checks-selfcheck.mjs: offline unit test covering each check (pass + fail incl. hash-mismatch, a new
failing test, an out-of-scope/junk diff) + the section-7 field names; node --check both files; all pass,
no live LLM.

## Out of scope
Runner wiring; the run driver; the analysis script; the powered run.
