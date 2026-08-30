/**
 * Smoke: validate focused/full layering (B-73cf).
 *
 * Proves configured validation commands keep their existing full default while
 * `--focus=<name>` is an explicit, tagged, fail-closed profile whose output is
 * clearly not final full validation or DONE-required proof.
 *
 * Run: node packages/main/dist/tasks/validate-focused-full-layering-smoke.js
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerifierHandlers } from '../handlers/verifier.js';
import { resetConfigCache } from '../core/config.js';
import type { HandlerContext } from '../handlers/context.js';

const NODE = process.execPath;

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    validate: {
      commands: [
        {
          label: 'fast-tagged',
          command: NODE,
          args: ['-e', 'console.log("fast tagged command")'],
          focus: ['fast'],
        },
        {
          label: 'full-only',
          command: NODE,
          args: ['-e', 'console.log("full only command")'],
        },
      ],
    },
  }, null, 2));
}

async function run(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-focus-'));
  try {
    writeConfig(root);
    resetConfigCache();
    const ctx = {
      root,
      scanRoot: root,
      store: {},
    } as HandlerContext;
    const validate = createVerifierHandlers(ctx).validate;

    const full = JSON.parse(await validate({ json: true }));
    check('full provider remains configured commands', full.provider === 'proof-or-stop-verifier-configured-commands');
    check('full run executes all configured commands', full.commands.length === 2);
    check('full run has no focused metadata', full.focus === undefined);
    check('full summary is not marked focused', !String(full.summary).includes('Focused validation'));

    const focused = JSON.parse(await validate({ focus: 'fast', json: true }));
    check('focused provider is visibly focused', focused.provider === 'proof-or-stop-verifier-configured-commands-focused');
    check('focused run executes only tagged commands', focused.commands.length === 1 && focused.commands[0].label === 'fast-tagged');
    check('focused summary names focused mode', String(focused.summary).includes('Focused validation (fast)'));
    check('focused details reject final proof interpretation', focused.details.some((line: string) => line.includes('not final full validation') && line.includes('not DONE-required proof')));
    check('focused JSON marks non-final proof status', focused.focus?.name === 'fast' && focused.focus.finalFullValidation === false && focused.focus.doneRequiredProof === false);

    let failedClosed = false;
    try {
      await validate({ focus: 'missing', json: true });
    } catch (e) {
      failedClosed = String(e instanceof Error ? e.message : e).includes('no configured validate.commands are tagged');
    }
    check('missing focus fails closed', failedClosed);

    console.log(`validate-focused-full-layering smoke passed: ${passed} assertions`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

void run().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
