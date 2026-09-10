#!/usr/bin/env node

/**
 * Safe, no-provider regression for corrupt provider-slot capacity accounting.
 * It writes only a temporary malformed slot and exercises no process probes or
 * signals.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireProviderProcessSlot,
  providerProcessSlotsDir,
  releaseProviderProcessSlot,
} from '../core/provider-process-registry.js';

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'provider-process-registry-corrupt-cap-'));
  const now = Date.now();
  const staleMs = 1_000;
  try {
    const slots = providerProcessSlotsDir(root);
    mkdirSync(slots, { recursive: true });
    writeFileSync(join(slots, 'slot-1.json'), '{malformed', { mode: 0o600 });

    const blocked = acquireProviderProcessSlot(slots, 1, staleMs, now, {
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      host: 'codex',
      storyId: null,
      agentType: 'corrupt-cap-smoke',
    });
    assert.equal(blocked, null,
      'a fresh non-reclaimable corrupt high-index slot consumes cap=1 capacity');
    assert.equal(existsSync(join(slots, 'slot-0.json')), false,
      'admission does not bypass the corrupt high-index occupant by creating slot 0');

    const recovered = acquireProviderProcessSlot(slots, 1, staleMs, now + (2 * staleMs), {
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      host: 'codex',
      storyId: null,
      agentType: 'corrupt-cap-smoke',
    });
    assert.ok(recovered, 'the stale orphan backstop eventually reclaims the malformed slot');
    assert.match(recovered.file, /slot-0\.json$/,
      'recovered admission returns to the bounded current cap index');
    releaseProviderProcessSlot(recovered.file, recovered.token);

    const unlinkFailure = join(slots, 'slot-1.json');
    writeFileSync(unlinkFailure, '{stale-but-unlink-denied', { mode: 0o600 });
    utimesSync(unlinkFailure, new Date(now - (2 * staleMs)), new Date(now - (2 * staleMs)));
    const unlinkDenied = acquireProviderProcessSlot(slots, 1, staleMs, now, {
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      host: 'codex',
      storyId: null,
      agentType: 'unlink-denied-cap-smoke',
    }, {}, {
      unlinkForReclaim(file) {
        if (file === unlinkFailure) {
          const error = new Error('injected stale slot unlink denial') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
      },
    });
    assert.equal(unlinkDenied, null,
      'a stale/corrupt slot whose unlink fails remains an occupant instead of bypassing cap=1');
    assert.equal(existsSync(join(slots, 'slot-0.json')), false,
      'failed stale reclaim never admits a second slot below the configured cap');
    writeFileSync(unlinkFailure, '{reclaimable-after-denial', { mode: 0o600 });
    utimesSync(unlinkFailure, new Date(now - (2 * staleMs)), new Date(now - (2 * staleMs)));

    const replacement = join(slots, 'slot-1.json');
    writeFileSync(replacement, '{stale-corrupt', { mode: 0o600 });
    utimesSync(replacement, new Date(now - (2 * staleMs)), new Date(now - (2 * staleMs)));
    let replaced = false;
    const replacementBlocked = acquireProviderProcessSlot(slots, 1, staleMs, now, {
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      host: 'codex',
      storyId: null,
      agentType: 'replacement-cap-smoke',
    }, {}, {
      beforeReclaimRecheck(file) {
        if (file !== replacement || replaced) return;
        replaced = true;
        writeFileSync(file, JSON.stringify({
          pid: process.pid,
          startedAt: new Date(now).toISOString(),
          host: 'codex',
          storyId: null,
          agentType: 'replacement-cap-smoke',
          token: 'replacement-holder',
        }), { mode: 0o600 });
      },
    });
    assert.equal(replaced, true, 'replacement race hook runs between stale read and reclaim recheck');
    assert.equal(replacementBlocked, null,
      'a replacement high-index holder remains counted instead of admitting slot 0 past cap=1');
    assert.equal(existsSync(join(slots, 'slot-0.json')), false,
      'replacement race never creates a second slot while the replacement holder is live');

    console.log('provider-process-registry-corrupt-cap-smoke PASS');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

main();
