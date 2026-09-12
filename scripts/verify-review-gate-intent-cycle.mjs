#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const sourceUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(sourceUrl)) return nextResolve(sourceUrl.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
  },
});

const storyReview = await import('../packages/main/src/handlers/story-review.ts');

assert.equal(
  typeof storyReview.reviewGateVerificationIntentIssue,
  'function',
  'REVIEW_GATE_INTENT_CYCLE: PLAN review must expose the lifecycle-dependency classifier',
);

const classify = storyReview.reviewGateVerificationIntentIssue;
const blocked = classify({
  desc: 'Independent review has no unresolved high or critical finding.',
  type: 'manual',
  priority: 'must',
});
assert.ok(blocked, 'REVIEW_GATE_INTENT_CYCLE: an independent-review verdict cannot be pre-REVIEW verification evidence');
assert.equal(blocked.type, 'review_gate_as_verification_intent');
assert.equal(blocked.severity, 'blocker');
assert.match(blocked.message, /review_pass_set|finding_add/);
assert.match(blocked.message, /remove.*verificationIntent/i);

for (const legitimate of [
  { desc: 'The parser rejects unresolved symbolic references.', type: 'logic', priority: 'must' },
  { desc: 'A review screen renders unresolved findings for the user.', type: 'browser', priority: 'must' },
  { desc: 'A reviewer can open the generated report.', type: 'cli', priority: 'must' },
]) {
  assert.equal(
    classify(legitimate),
    null,
    `REVIEW_GATE_INTENT_CYCLE: product behavior must not be mistaken for lifecycle evidence: ${legitimate.desc}`,
  );
}

const handlerSource = readFileSync(new URL('../packages/main/src/handlers/story-review.ts', import.meta.url), 'utf8');
assert.match(
  handlerSource,
  /reviewGateVerificationIntentIssue\(intent\)/,
  'REVIEW_GATE_INTENT_CYCLE: story_review must consume the classifier for every authored intent',
);

const handoffSource = readFileSync(new URL('../packages/main/src/handlers/testintent-handoff.ts', import.meta.url), 'utf8');
assert.match(
  handoffSource,
  /Do not encode .*review_pass_set.*finding_add.*verificationIntent/i,
  'REVIEW_GATE_INTENT_CYCLE: the PLAN authoring prompt must prohibit lifecycle review evidence as intent',
);

console.log('REVIEW_GATE_INTENT_CYCLE: review-only gate evidence is rejected during PLAN');
