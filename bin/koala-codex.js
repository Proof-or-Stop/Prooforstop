#!/usr/bin/env node
/**
 * Codex-friendly koala bootstrap.
 * Tags activity.jsonl entries with source=codex and a stable session when
 * the host exposes one.
 */
process.env.KOALA_ACTIVITY_SOURCE = 'codex';
process.env.KOALA_ACTIVITY_RECORD_READONLY = '1';
process.env.KOALA_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

// Reuse the existing koala bootstrap entry.
await import('./koala.js');
