#!/usr/bin/env node
/**
 * Codex-friendly koala bootstrap.
 * Tags activity.jsonl entries with source=codex.
 */
process.env.KOALA_ACTIVITY_SOURCE = process.env.KOALA_ACTIVITY_SOURCE || 'codex';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

// Reuse the existing koala bootstrap entry
import('./koala.js');
