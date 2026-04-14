#!/usr/bin/env node
/**
 * Codex-friendly koala bootstrap.
 *
 * Uses the full main+utils toolset and tags activity.jsonl entries with
 * source=codex so Koala telemetry can distinguish Codex-driven runs from
 * plain CLI usage and Claude hooks.
 */

process.env.KOALA_ACTIVITY_SOURCE = process.env.KOALA_ACTIVITY_SOURCE || 'codex';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

import { runCli } from '../packages/main/dist/cli-engine.js';
import { register, utilsToolDefs } from '../packages/utils/dist/index.js';

runCli({
  extraTools: utilsToolDefs,
  extraRegister: register,
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
