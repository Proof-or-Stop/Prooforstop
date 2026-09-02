#!/usr/bin/env node
/**
 * Regression smoke for Codex adapter evidence gate scope (B-d43b).
 *
 * The gate must ignore ordinary provider/host prose that mentions Codex while
 * still requiring evidence when a story touches concrete adapter assets,
 * wrappers, hooks, or verify/doctor surfaces.
 */

import assert from 'node:assert/strict';
import { storyRequiresCodexEvidence } from '../core/codex-adapter-checks.js';
import type { StoryStore } from '../core/store.js';

const STORY_ID = 'B-d43b-smoke';
const PASS_LINE =
  '✓ codex adapter gate scope smoke passed: provider-only Codex text ignored; adapter surfaces required';

function fakeStore(text: string): StoryStore {
  return {
    readStory(storyId: string) {
      assert.equal(storyId, STORY_ID);
      return {
        title: 'Evidence gate scope smoke',
        description: text,
        riskSignals: [
          {
            category: 'provider-host-prose',
            matched: text,
          },
        ],
      };
    },
    readChecklist(storyId: string) {
      assert.equal(storyId, STORY_ID);
      return {
        items: [
          {
            id: 'CHK-001',
            title: text,
            context: text,
            relatedDocs: [text],
          },
        ],
      };
    },
  } as unknown as StoryStore;
}

const providerOnlyCodexTexts = [
  'A provider.codex step may ask the Codex CLI host to run implementation work; this is only provider and host prose.',
  'The Codex CLI host can run this task as a bounded provider, with ordinary host routing text only.',
];

for (const text of providerOnlyCodexTexts) {
  assert.equal(
    storyRequiresCodexEvidence(fakeStore(text), STORY_ID),
    false,
    `provider-only Codex prose must not require adapter evidence: ${text}`,
  );
}

const adapterSurfaceTerms = [
  // B-cc10 F-055: canonical first; a renamed root silently yields zero files.
  '.proof-or-stop-codex',
  '.proof-or-stop-codex',
  'proof-or-stop-codex',
  'codex adapter',
  'verify_codex',
  'bin/proof-or-stop-codex.js',
  '.codex/hooks.json',
  'proof-or-stop codex verify',
  'proof-or-stop codex doctor',
];

for (const term of adapterSurfaceTerms) {
  assert.equal(
    storyRequiresCodexEvidence(fakeStore(`Story touches adapter surface: ${term}`), STORY_ID),
    true,
    `adapter surface must require Codex adapter evidence: ${term}`,
  );
}

console.log(PASS_LINE);
