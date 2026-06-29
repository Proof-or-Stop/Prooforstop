#!/usr/bin/env node
/**
 * Legacy quarantine smoke.
 *
 * The public story resolver command was retired from active help/catalog/config.
 * This compatibility smoke now asserts the old command is absent while the
 * observability snapshot remains the active local-assurance surface.
 */
import assert from 'node:assert/strict';
import { MAIN_TOOLS } from '../cli-engine.js';

const toolNames = new Set(MAIN_TOOLS.map(tool => tool.name));

assert.equal(toolNames.has('story_authority_resolve'), false);
assert.equal(toolNames.has('observability_snapshot'), true);

process.stdout.write('legacy story resolver command quarantine smoke PASS\n');

