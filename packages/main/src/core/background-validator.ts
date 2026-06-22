/**
 * B-45ed CHK-006: background.md four-section format validator
 *
 * In the source-of-truth hierarchy, background.md carries the "why" dimension and is the first layer of the story knowledge base.
 * This module is extracted as pure functions for reuse by CHK-007's background_set / background_append.
 *
 * Hard minimums (aligned with the "background.md four-section format" subsection of CLAUDE.md):
 *   - All 4 section headers present (order not enforced, but each must appear exactly once)
 *   - Each section body >= 50 characters (content after the section header and before the next section header, excluding the header itself)
 *   - Total length >= 300 characters
 *   - The "## Trigger Event" section must contain one of the id regexes:
 *       B-[a-z0-9]{4} / F-\d+ / CHK-\d+ / [a-f0-9]{7,} hash / ISO date \d{4}-\d{2}-\d{2}
 */

export const REQUIRED_SECTIONS = [
  'Trigger Event',
  'Key Insights',
  'Solution Tradeoffs',
  'Conversational Texture',
] as const;

export type RequiredSection = typeof REQUIRED_SECTIONS[number];

export const BACKGROUND_SECTION_IDS = [
  'trigger_event',
  'key_insight',
  'tradeoff',
  'conversation_texture',
] as const;

export type BackgroundSectionId = typeof BACKGROUND_SECTION_IDS[number];

export const BACKGROUND_SECTION_TITLES: Record<BackgroundSectionId, RequiredSection> = {
  trigger_event: 'Trigger Event',
  key_insight: 'Key Insights',
  tradeoff: 'Solution Tradeoffs',
  conversation_texture: 'Conversational Texture',
};

const BACKGROUND_SECTION_ID_BY_TITLE = new Map<string, BackgroundSectionId>(
  Object.entries(BACKGROUND_SECTION_TITLES).map(([id, title]) => [title, id as BackgroundSectionId]),
);

const BACKGROUND_SECTION_ALIASES = new Map<string, BackgroundSectionId>([
  ['Key Insight', 'key_insight'],
  ['Tradeoff', 'tradeoff'],
  ['Tradeoffs', 'tradeoff'],
  ['Trade-offs', 'tradeoff'],
  ['Option Tradeoffs', 'tradeoff'],
  ['Conversation Texture', 'conversation_texture'],
  ['Dialogue Texture', 'conversation_texture'],
]);

export function normalizeBackgroundSection(value: string): BackgroundSectionId | null {
  const trimmed = value.trim();
  if ((BACKGROUND_SECTION_IDS as readonly string[]).includes(trimmed)) {
    return trimmed as BackgroundSectionId;
  }
  return BACKGROUND_SECTION_ID_BY_TITLE.get(trimmed) ?? BACKGROUND_SECTION_ALIASES.get(trimmed) ?? null;
}

export function backgroundSectionTitle(sectionId: BackgroundSectionId): RequiredSection {
  return BACKGROUND_SECTION_TITLES[sectionId];
}

const TRIGGER_ID_PATTERNS: RegExp[] = [
  /B-[a-z0-9]{4}\b/,
  /F-\d+\b/,
  /CHK-\d+\b/,
  /\b[a-f0-9]{7,}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
];

export type ValidateResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Split the markdown text by "## <title>" section headers and return a map of each section's content.
 * The preamble before the section headers (e.g. the "# Background: xxx" title) is ignored.
 * If the same section header appears multiple times -> keep the content of the first occurrence (the validation layer separately reports a "duplicate section header" error).
 */
export function parseSections(content: string): { sections: Map<string, string>; headers: string[]; duplicates: string[] } {
  const lines = content.split(/\r?\n/);
  const sections = new Map<string, string>();
  const headers: string[] = [];
  const duplicates: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null) {
      if (sections.has(current)) {
        if (!duplicates.includes(current)) duplicates.push(current);
      } else {
        sections.set(current, buf.join('\n'));
      }
    }
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      const sectionId = normalizeBackgroundSection(m[1]);
      current = sectionId ? backgroundSectionTitle(sectionId) : m[1];
      headers.push(current);
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return { sections, headers, duplicates };
}

export function validateBackground(content: string): ValidateResult {
  const errors: string[] = [];

  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, errors: ['background content is empty'] };
  }

  const totalLen = content.length;
  if (totalLen < 300) {
    errors.push(`total length ${totalLen} chars < 300 (hard minimum)`);
  }

  const { sections, headers, duplicates } = parseSections(content);

  const missing = REQUIRED_SECTIONS.filter(s => !sections.has(s));
  if (missing.length > 0) {
    errors.push(
      `missing section headers: ${missing.map(s => `"## ${s}"`).join(', ')}; ` +
      `expected 4 sections: ${REQUIRED_SECTIONS.map(s => `"## ${s}"`).join(' / ')}; ` +
      `currently detected: ${headers.length > 0 ? headers.map(h => `"## ${h}"`).join(', ') : '(none)'}`
    );
  }

  if (duplicates.length > 0) {
    errors.push(`duplicate section headers: ${duplicates.map(s => `"## ${s}"`).join(', ')} (each section allowed only once)`);
  }

  // Per-section body length check (only check if section exists, to avoid duplicate errors)
  for (const name of REQUIRED_SECTIONS) {
    const body = sections.get(name);
    if (body === undefined) continue; // already reported in missing
    const trimmed = body.trim();
    if (trimmed.length < 50) {
      errors.push(`"## ${name}" section body ${trimmed.length} chars < 50 (hard minimum)`);
    }
  }

  // Trigger Event must contain id
  const triggerBody = sections.get('Trigger Event');
  if (triggerBody !== undefined && triggerBody.trim().length > 0) {
    const matched = TRIGGER_ID_PATTERNS.some(re => re.test(triggerBody));
    if (!matched) {
      errors.push(
        '"## Trigger Event" section did not match any id regex: ' +
        'B-[a-z0-9]{4} / F-\\d+ / CHK-\\d+ / [a-f0-9]{7,} / \\d{4}-\\d{2}-\\d{2}; ' +
        'must contain a specific story/finding/commit/date identifier; abstract phrasing like "process needs improvement" is not allowed'
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
