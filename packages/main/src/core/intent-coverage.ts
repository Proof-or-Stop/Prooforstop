import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';
import type { StoryStore } from './store.js';
import { collectVerificationIntents } from './verification.js';

export interface IntentCoverageMissing {
  ref: string;
  desc: string;
}

export interface IntentCoverageSummary {
  total: number;
  covered: number;
  missing: IntentCoverageMissing[];
}

export function collectFixtureIntentRefs(root: string, storyId: string): Set<string> {
  const refs = new Set<string>();
  const config = loadConfig(root);
  const fixturesDir = join(root, config.fixturesDir);
  if (!existsSync(fixturesDir)) return refs;
  const scopedPrefix = `${storyId}:`;

  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
        for (const c of content.cases || []) {
          if (!c.intentRef || typeof c.intentRef !== 'string') continue;
          const ref = c.intentRef as string;
          if (ref.startsWith(scopedPrefix)) {
            refs.add(ref.slice(scopedPrefix.length));
          } else if (c.storyId === storyId && /^CHK-\d+:(happy|edge|adversarial):\d+$/.test(ref)) {
            refs.add(ref);
          }
        }
      } catch { /* PROBE: ignore malformed/unreadable fixture files while collecting coverage */ }
    }
  };

  scanDir(fixturesDir);
  return refs;
}

export function summarizeIntentCoverage(root: string, store: StoryStore, storyId: string): IntentCoverageSummary {
  const checklist = store.readChecklist(storyId);
  const refs = collectFixtureIntentRefs(root, storyId);
  const missing: IntentCoverageMissing[] = [];
  let total = 0;

  for (const item of checklist.items) {
    const verificationIntents = collectVerificationIntents(item);
    if (verificationIntents.length > 0) {
      for (const { ref, intent } of verificationIntents) {
        total++;
        if (!refs.has(ref)) missing.push({ ref, desc: intent.desc });
      }
      continue;
    }

    // Legacy fallback for pre-verificationIntent story data.
    const legacyIntent = item.testIntent;
    if (!legacyIntent) continue;
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      const entries = legacyIntent[lane] || [];
      for (let i = 0; i < entries.length; i++) {
        total++;
        const ref = `${item.id}:${lane}:${i}`;
        if (!refs.has(ref)) {
          const entry = entries[i];
          const desc = typeof entry === 'string' ? entry : entry.desc;
          missing.push({ ref, desc });
        }
      }
    }
  }

  return { total, covered: total - missing.length, missing };
}
