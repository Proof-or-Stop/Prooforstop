/**
 * Lab initplan (bench-staging/oldpos/initplan-breakdown.md §5 rank 2; EXPERIMENTAL A/B `plan.reviewerPreload`,
 * default off). In runs 72 / 77 / 80 every scope-plan reviewer run spent 25-72 s (7-8 small requests, 14-43
 * tool calls; 82-143 s per run summed) re-reading background.md, the checklist, plan.md and the config before
 * its first analysis request, and every rerun read them again. With the switch on, the dispatch prompt carries
 * them (current at launch), so the reviewer starts at the analysis. The same information, fewer round trips:
 * the review rules, the request block, the pin audit and the save contract are unchanged. Because it changes the
 * reviewer's input, it is an A/B switch, not a default.
 *
 * Bounded: each file at most PRELOAD_FILE_CAP bytes (a cut file says so and keeps its path to read the rest).
 */
import { existsSync, readFileSync } from 'node:fs';

import { reviewerPreloadOn } from './ab-variants.js';
import { loadConfig } from './config.js';
import type { StoryStore } from './store.js';
import { VERIFICATION_LANES } from './verification.js';

const PRELOAD_FILE_CAP = 24_000;

function clipped(text: string, path: string): string {
  if (Buffer.byteLength(text) <= PRELOAD_FILE_CAP) return text.replace(/\n$/, '');
  return `${text.slice(0, PRELOAD_FILE_CAP)}\n[... cut at ${PRELOAD_FILE_CAP} bytes; read ${path} for the rest]`;
}

/** Whether the switch is on for this project (malformed or unreadable config = off). */
export function scopePlanPreloadActive(root: string): boolean {
  try { return reviewerPreloadOn(loadConfig(root)); } catch { return false; }
}

/**
 * The preload block of the scope-plan prompt (empty when the switch is off): each Story artifact the reviewer must
 * read, inline, plus the checklist rows in a compact form and the project validate config.
 */
export function renderScopePlanPreload(store: StoryStore, root: string, storyId: string): string[] {
  if (!scopePlanPreloadActive(root)) return [];
  const rel = (name: string): string => `${store.storyDirRel()}/${storyId}/${name}`;
  const lines: string[] = ['', 'Preloaded Story artifacts (A/B plan.reviewerPreload=on; current at launch). They are the "Must read" files above: do not re-read them; read code, tests, specs and anything else as usual.'];
  for (const name of ['background.md', 'understanding.json', 'plan.md', 'decision.json']) {
    const path = store.storyFilePath(storyId, name);
    if (!existsSync(path)) continue;
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    if (!text.trim()) continue;
    lines.push(`<<<FILE ${rel(name)}`, clipped(text, rel(name)), 'FILE>>>');
  }
  try {
    const items = store.readChecklist(storyId).items;
    const compact = items.map(item => ({
      id: item.id, title: item.title, status: item.status, context: item.context, userSees: item.userSees,
      ...(item.excludes?.length ? { excludes: item.excludes } : {}), files: item.files,
      verificationIntent: Object.fromEntries(VERIFICATION_LANES.map(lane => [lane, (item.verificationIntent?.[lane] ?? []).map((row, index) => ({
        ref: `${item.id}:${lane}:${index}`, desc: row.desc, type: row.type, priority: row.priority,
        ...(row.verification ? { verification: row.verification } : {}), ...(row.derivation ? { derivation: row.derivation } : {}),
        ...((row as { baseValue?: unknown }).baseValue !== undefined ? { baseValue: (row as { baseValue?: unknown }).baseValue } : {}),
      }))])),
    }));
    lines.push(`<<<FILE ${rel('checklist.json')} (compact: every item and row; row ref = CHK-NNN:<lane>:<index>)`, clipped(JSON.stringify(compact, null, 1), rel('checklist.json')), 'FILE>>>');
  } catch { /* unreadable checklist: the reviewer reads the file */ }
  try {
    const validate = (loadConfig(root) as { validate?: unknown }).validate;
    if (validate) lines.push(`Project validate config (proof-or-stop.config.json validate): ${JSON.stringify(validate).slice(0, 2000)}`);
  } catch { /* no config */ }
  return lines;
}
