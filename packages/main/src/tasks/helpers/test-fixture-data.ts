/**
 * Test-only fixture data read from packages/main/tests/fixtures/<name>.json.
 *
 * Old-PoS run 32: task fixtures compiled from src/tasks/helpers landed in
 * dist/tasks/helpers, the benchmark bundle shipped them, and the owner read a
 * prior run's checklist (an answer key) from /opt/pos. Fixture DATA therefore
 * lives outside src/ (tsc never emits it into dist); this loader carries none.
 */
import { readFileSync } from 'node:fs';

/** The parsed JSON fixture `name` (dist/tasks/helpers/x.js -> packages/main/tests/fixtures/name.json). */
export function readTestFixture<T>(name: string): T {
  const url = new URL(`../../../tests/fixtures/${name}.json`, import.meta.url);
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as T;
  } catch (error) {
    throw new Error(`test fixture ${name} unreadable at ${url.pathname} (test-only data, not shipped in dist): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface FixtureItem { id: string; title: string; rows: Array<['happy' | 'edge' | 'adversarial', string]> }

/** abs-stepped-slices: the verbatim request of old-PoS runs 22-30 and the owner checklists of runs 27-30 (fixture notes name each run's findings). */
export interface AbsSteppedSlicesFixture {
  request: string;
  notes: Record<string, string>;
  RUN27_ITEMS: FixtureItem[];
  RUN28_ITEMS: FixtureItem[];
  RUN29_ITEMS: FixtureItem[];
  RUN30_ITEMS: FixtureItem[];
}

export const absSteppedSlicesFixture = (): AbsSteppedSlicesFixture => readTestFixture<AbsSteppedSlicesFixture>('abs-stepped-slices');
