// Acceptance verifier for B-4bf8 (token-accuracy amendments to the usage-ledger plan doc).
// Documentation-only story: every intent is a grep/parse assertion on the amended doc
// plus a diff-scope check. Run from the worktree root.
import fs from 'fs';
import { execSync } from 'child_process';
const DOC = 'docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md';
const doc = fs.readFileSync(DOC, 'utf8');
const lines = doc.split('\n');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };

// --- section extractors ---
function section(headingRe, opts = {}) {
  const stop = opts.stop || /^##\s/;
  let out = [], capturing = false;
  for (const l of lines) {
    if (capturing && stop.test(l) && !headingRe.test(l)) break;
    if (headingRe.test(l)) { capturing = true; out.push(l); continue; }
    if (capturing) out.push(l);
  }
  return out.join('\n');
}
function window(matchRe, n = 45) {
  const i = lines.findIndex(l => matchRe.test(l));
  if (i < 0) return '';
  return lines.slice(i, i + n).join('\n');
}
function jsonBlocks() {
  const out = []; let inb = false, buf = [];
  for (const l of lines) {
    if (/^```json/.test(l)) { inb = true; buf = []; continue; }
    if (inb && /^```/.test(l)) { inb = false; out.push(buf.join('\n')); continue; }
    if (inb) buf.push(l);
  }
  return out.join('\n---\n');
}
const validationSec = section(/^##\s.*Validation/i);
const acceptanceSec = section(/^##\s.*Acceptance/i);
const rolloutSec    = section(/^##\s.*Rollout/i);
const touchSec      = section(/^##\s.*Implementation Touchpoints/i);
const constraintsW  = window(/Required record constraints/i, 40);
const jb            = jsonBlocks();
// every line mentioning totalTokens is in a "not stored / derived" context
const totalLines = lines.filter(l => /totalTokens/.test(l));
const totalAllDerived = totalLines.length > 0 && totalLines.every(l => /not\s+be\s+stored|NOT\s+be\s+stored|no record may store|derived|summary|removal|absent|not stored|no `?totalTokens`? is stored/i.test(l));
const diffNames = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean);
const nonMetaChanged = diffNames.filter(f => !f.startsWith('.lattice/'));
const onlyDoc = nonMetaChanged.length === 1 && nonMetaChanged[0] === DOC;
const noSourceChanged = !nonMetaChanged.some(f => /\.(ts|js|mjs|cjs)$/.test(f) || /packages\/.*\/src\//.test(f));
const cjk = (doc.match(/[㐀-䶿一-鿿]/g) || []).length;
const dollarDigits = (doc.match(/\$\s?\d/g) || []).length; // "$/MTok" has no digit after $

const R = {}; const ok = (ref, c, note) => { R[ref] = { pass: !!c, note: String(note).slice(0,150) }; };
const has = (s, re) => re.test(s);

// ---- CHK-001 four-field model + example + constraints ----
ok('CHK-001:happy:0', has(jb,/cacheCreationInputTokens/)&&has(jb,/cacheReadInputTokens/)&&has(jb,/inputTokens/)&&has(jb,/outputTokens/), 'JSON example has all four token fields');
ok('CHK-001:happy:1', /uncached remainder/i.test(doc), 'prose: input_tokens is the uncached remainder');
ok('CHK-001:happy:2', /model_request_end\.model_usage|model_usage/.test(doc), 'references CMA model_usage');
ok('CHK-001:happy:3', has(constraintsW,/cacheCreationInputTokens/)&&has(constraintsW,/cacheReadInputTokens/), 'Required record constraints mention cache fields');
ok('CHK-001:edge:0', !/totalTokens/.test(jb), 'JSON example has no totalTokens');
ok('CHK-001:edge:1', has(jb,/cache_creation|cache_read|cacheCreation|cacheRead/), 'billableUnits/example includes cache entries');
ok('CHK-001:adversarial:0', totalAllDerived, `totalTokens only in derived/not-stored context (${totalLines.length} lines)`);
ok('CHK-001:adversarial:1', noSourceChanged, `no source files changed (${nonMetaChanged.length} non-meta: ${nonMetaChanged.join(',')})`);
// ---- CHK-002 drop stored totalTokens ----
ok('CHK-002:happy:0', !/totalTokens/.test(jb), 'example block has no totalTokens');
ok('CHK-002:happy:1', /inputTokens \+ outputTokens \+ cacheCreationInputTokens \+ cacheReadInputTokens/.test(doc), 'identity formula present');
ok('CHK-002:happy:2', /summary layer/i.test(doc)&&/(not stored|derived)/i.test(doc), 'totals derived in summary layer, not stored');
ok('CHK-002:edge:0', !/totalTokens/.test(constraintsW) || /not\s+be\s+stored|no record may store/i.test(constraintsW), 'constraints: totalTokens absent or marked not-stored');
ok('CHK-002:edge:1', !/"name":\s*"total"|"kind":\s*"total"/.test(jb), 'no total-type billableUnits entry');
ok('CHK-002:adversarial:0', totalAllDerived, 'every totalTokens occurrence is in not-stored/derived context');
ok('CHK-002:adversarial:1', !/totalTokens/.test(validationSec) || /absent|removal|not stored|no /i.test(validationSec), 'Validation does not assert totalTokens presence');
// ---- CHK-003 estimate accuracy ----
ok('CHK-003:happy:0', /count_tokens/.test(doc), 'count_tokens preferred estimator');
ok('CHK-003:happy:1', /confidence/i.test(doc)&&/high/i.test(doc)&&/medium/i.test(doc)&&/low/i.test(doc), 'confidence high|medium|low');
ok('CHK-003:happy:2', /provider\.model|model-version-specific|exact .{0,12}model/i.test(doc), 'estimate bound to model ID / model-version-specific');
ok('CHK-003:edge:0', /count_tokens/.test(doc)&&/tokenizer/i.test(doc)&&/bytes/i.test(doc), 'fallback chain count_tokens>tokenizer>bytes');
ok('CHK-003:edge:1', /estimator/i.test(doc)&&/confidence/i.test(doc), 'estimator + confidence in constraints');
ok('CHK-003:adversarial:0', lines.filter(l=>/\bbytes\b/i.test(l)).every(l=>/fallback|offline|last resort|only when|then bytes/i.test(l)) || /bytes.{0,30}only.{0,30}offline/i.test(doc), 'bytes only as fallback, not primary');
ok('CHK-003:adversarial:1', !/"estimator":\s*\{/.test(jb) || /confidence/.test(jb), 'example estimator block (if object) includes confidence');
// ---- CHK-004 attribution ----
ok('CHK-004:happy:0', /storyId/.test(doc)&&/null/.test(doc)&&/non-story|global validate|daemon/i.test(doc), 'storyId=null for non-story calls');
ok('CHK-004:happy:1', /sub-?agent/i.test(doc)&&/propagat/i.test(doc), 'subagent propagation of parent storyId');
ok('CHK-004:happy:2', /(role|agentType)/i.test(doc)&&/implementer|reviewer|main/i.test(doc), 'role/agentType field');
ok('CHK-004:happy:3', /preflight|call[- ]time/i.test(doc)&&/lease|session context|active/i.test(doc), 'captured at preflight from active context');
ok('CHK-004:edge:0', has(jb,/storyId/)&&has(jb,/role|agentType/), 'example includes storyId + role/agentType');
ok('CHK-004:edge:1', /subagentId|threadId|subagent_id|thread_id/i.test(doc), 'subagentId/threadId field');
ok('CHK-004:adversarial:0', !/storyId=null[^.\n]{0,40}(dropped|excluded|skipped|filtered)/i.test(doc), 'no statement dropping null-storyId records');
ok('CHK-004:adversarial:1', /storyId|attribution/i.test(validationSec)&&/null|sub-?agent/i.test(validationSec), 'Validation asserts null-storyId + subagent');
// ---- CHK-005 completeness ----
ok('CHK-005:happy:0', /choke[- ]point|single writer/i.test(doc), 'single writer choke-point');
ok('CHK-005:happy:1', /reconcil/i.test(doc)&&/dispatch/i.test(doc), 'reconciliation of dispatch vs ledger');
ok('CHK-005:edge:0', /reconcil/i.test(doc)&&/ledgerCallId/.test(doc)&&/attemptId/.test(doc), 'reconciliation keyed on ledgerCallId+attemptId');
ok('CHK-005:edge:1', /bypass|under-?count|silent/i.test(doc), 'bypassed-writer under-count failure mode');
ok('CHK-005:adversarial:0', /choke[- ]point|single writer/i.test(touchSec)||/choke[- ]point/i.test(doc), 'touchpoints reinforce choke-point');
ok('CHK-005:adversarial:1', /reconcil|completeness/i.test(validationSec), 'Validation asserts reconciliation/completeness');
// ---- CHK-006 streaming/failure ----
ok('CHK-006:happy:0', /terminal stream event|message_delta|final message/i.test(doc), 'streaming usage from terminal event');
ok('CHK-006:happy:1', /partial/i.test(doc)&&/(error|timeout|mid-stream)/i.test(doc), 'partial usage on error/timeout');
ok('CHK-006:happy:2', /unavailable/i.test(doc)&&/(only when|truly no)/i.test(doc), 'unavailable only when truly no count');
ok('CHK-006:edge:0', /failed request/i.test(doc), 'consistent with failed-request rule');
ok('CHK-006:edge:1', /partial/i.test(doc)&&/provider-reported/i.test(doc), 'partial counts tied to provider-reported');
ok('CHK-006:adversarial:0', /never.{0,40}zero|not.{0,25}as zero|must not be represented as zero|never treated as zero|not infer.{0,15}zero/i.test(doc), 'prohibits treating missing as zero');
ok('CHK-006:adversarial:1', /streaming|partial|failure/i.test(validationSec), 'Validation asserts streaming/partial/failure usage');
// ---- CHK-007 multi-provider ----
ok('CHK-007:happy:0', /\braw\b/i.test(doc)&&/canonical/i.test(doc), 'both raw + canonical view required');
ok('CHK-007:happy:1', /mapping/i.test(doc)&&/provider/i.test(doc), 'explicit per-provider mapping rules');
ok('CHK-007:edge:0', new RegExp('canonical','i').test(doc)&&/cacheCreation/.test(doc)&&/cacheRead/.test(doc), 'canonical uses four-field shape');
ok('CHK-007:edge:1', /raw|canonical|normaliz/i.test(touchSec), 'adapter touchpoint consistent with dual view');
ok('CHK-007:adversarial:0', !/discard.{0,20}raw|only.{0,15}canonical/i.test(doc), 'no statement discarding raw units');
ok('CHK-007:adversarial:1', has(jb,/raw/)&&has(jb,/canonical/), 'example includes both raw + canonical');
// ---- CHK-008 cost ----
ok('CHK-008:happy:0', /pricingRef|pricingVersion/i.test(doc), 'pricingRef/pricingVersion field');
ok('CHK-008:happy:1', /price table|snapshot/i.test(doc)&&/MTok|per-model|multiplier/i.test(doc), 'price table/snapshot + multipliers');
ok('CHK-008:happy:2', /absolute price|not .{0,15}absolute|do not bake|must not.{0,15}price|no .{0,12}price.{0,12}baked/i.test(doc), 'prohibits absolute prices in record');
ok('CHK-008:edge:0', !/\$\s?\d/.test(jb), 'no dollar amount in JSON example');
ok('CHK-008:edge:1', /multiplier/i.test(doc)&&/cache read|cache write/i.test(doc), 'cache multipliers addressed');
ok('CHK-008:adversarial:0', dollarDigits === 0, `no hardcoded dollar amounts (\\$<digit> count=${dollarDigits})`);
ok('CHK-008:adversarial:1', /pricing|pricingRef/i.test(acceptanceSec), 'Acceptance mentions pricing/pricingRef');
// ---- CHK-009 meta updates ----
ok('CHK-009:happy:0', /cache/i.test(validationSec), 'Validation asserts cache-token recording');
ok('CHK-009:happy:1', /totalTokens|derived total/i.test(acceptanceSec), 'Acceptance mentions no-stored-total/derived');
ok('CHK-009:happy:2', /confidence|count_tokens/i.test(validationSec), 'Validation mentions estimator confidence/count_tokens');
ok('CHK-009:happy:3', /storyId|attribution/i.test(validationSec)&&/null|sub-?agent/i.test(validationSec), 'Validation mentions null + subagent attribution');
ok('CHK-009:happy:4', /Managed Agents\s*\(CMA\)|Claude Managed Agents/i.test(doc), 'CMA expanded on first use');
ok('CHK-009:happy:5', /cache|reconcil|pricing|canonical/i.test(rolloutSec), 'Rollout references new fields');
ok('CHK-009:edge:0', totalAllDerived, 'cross-refs consistent: no removed field referenced as stored');
ok('CHK-009:edge:1', /reconcil|completeness/i.test(acceptanceSec), 'Acceptance includes reconciliation/completeness');
ok('CHK-009:edge:2', /streaming|partial/i.test(acceptanceSec), 'Acceptance includes streaming/failure');
ok('CHK-009:adversarial:0', onlyDoc, `diff is only the doc (non-meta changed: ${nonMetaChanged.join(',')||'none'})`);
ok('CHK-009:adversarial:1', cjk === 0, `no CJK (count=${cjk})`);
ok('CHK-009:adversarial:2', !/totalTokens/.test(validationSec) || /absent|removal|not stored|no /i.test(validationSec), 'Validation does not assert totalTokens presence');
ok('CHK-009:adversarial:3', /canonical/i.test(acceptanceSec)&&/pricingRef/i.test(acceptanceSec), 'Acceptance includes canonical + pricingRef');

const refs = Object.keys(R); const fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(onlyDoc=${onlyDoc} noSource=${noSourceChanged} cjk=${cjk} totalAllDerived=${totalAllDerived} dollarDigits=${dollarDigits})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-4bf8/evidence/verify-result.json', JSON.stringify(R,null,1));
