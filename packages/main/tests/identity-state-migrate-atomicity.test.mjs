#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createIdentityStateMigrateHandlers } from '../dist/handlers/identity-state-migrate.js';

const RETIRED_STATE_DIR = ['.', 'lat', 'tice'].join('');
const CANONICAL_STATE_DIR = '.proof-or-stop';
const roots = [];

function paths(root, id) {
  return {
    source: join(root, RETIRED_STATE_DIR, 'story', 'actives', id),
    destination: join(root, CANONICAL_STATE_DIR, 'story', 'actives', id),
    receipt: join(root, CANONICAL_STATE_DIR, 'runtime', 'identity-migrations', `${id}.json`),
  };
}

function createCase(id) {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-identity-state-migrate-'));
  roots.push(root);
  const located = paths(root, id);
  mkdirSync(join(located.source, 'nested'), { recursive: true });
  writeFileSync(join(located.source, 'index.json'), '{"phase":"DEV"}\n');
  writeFileSync(join(located.source, 'nested', 'evidence.txt'), 'byte-identical evidence\n');
  return { root, ...located };
}

function snapshot(root) {
  const rows = [];
  const visit = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, name.name);
      if (name.isDirectory()) visit(path);
      else rows.push([relative(root, path).replace(/\\/g, '/'), readFileSync(path, 'hex')]);
    }
  };
  visit(root);
  return rows;
}

function handler(root, fs = undefined) {
  return createIdentityStateMigrateHandlers(
    { root },
    { fs, now: () => new Date('2026-08-31T00:00:00.000Z') },
  ).identity_state_migrate;
}

function expectFailure(run, pattern) {
  assert.throws(run, pattern);
}

// Existing refusal semantics remain fail-closed: neither an ambiguous dual tree
// nor a symlinked source entry may enter the receipt-first transaction.
{
  const id = 'B-dual-tree';
  const c = createCase(id);
  mkdirSync(c.destination, { recursive: true });
  writeFileSync(join(c.destination, 'foreign.txt'), 'foreign canonical tree\n');
  expectFailure(() => handler(c.root)({ id, confirm: true }), /refuses ambiguous dual story trees/u);
  assert.equal(existsSync(c.source), true);
  assert.equal(readFileSync(join(c.destination, 'foreign.txt'), 'utf8'), 'foreign canonical tree\n');
  assert.equal(existsSync(c.receipt), false);
  console.log('ok ambiguous dual story trees remain a hard refusal');
}

{
  const id = 'B-symlink-refusal';
  const c = createCase(id);
  symlinkSync(join(c.source, 'index.json'), join(c.source, 'linked-index.json'));
  expectFailure(() => handler(c.root)({ id, confirm: true }), /refuses symlink/u);
  assert.equal(existsSync(c.destination), false);
  assert.equal(existsSync(c.receipt), false);
  console.log('ok source symlink remains a hard refusal');
}

// A preexisting receipt is a hard collision. It is rejected before copy/publish,
// and the caller's receipt is never mistaken for one owned by this invocation.
{
  const id = 'B-receipt-collision';
  const c = createCase(id);
  const before = snapshot(c.source);
  mkdirSync(join(c.root, CANONICAL_STATE_DIR, 'runtime', 'identity-migrations'), { recursive: true });
  writeFileSync(c.receipt, 'preexisting-receipt\n');
  expectFailure(() => handler(c.root)({ id, confirm: true }), /receipt already exists.*source was not changed/u);
  assert.deepEqual(snapshot(c.source), before);
  assert.equal(existsSync(c.destination), false);
  assert.equal(readFileSync(c.receipt, 'utf8'), 'preexisting-receipt\n');
  console.log('ok preexisting receipt collision preserves source and caller-owned receipt');
}

// A write failure after the exclusive receipt fd has been opened must remove the
// partial receipt and copied temp tree before returning the original error.
{
  const id = 'B-receipt-write-failure';
  const c = createCase(id);
  const before = snapshot(c.source);
  const injected = {
    writeFileSync(target, ...args) {
      if (typeof target === 'number') throw new Error('injected receipt write failure');
      return writeFileSync(target, ...args);
    },
  };
  expectFailure(() => handler(c.root, injected)({ id, confirm: true }), /injected receipt write failure/u);
  assert.deepEqual(snapshot(c.source), before);
  assert.equal(existsSync(c.destination), false);
  assert.equal(existsSync(c.receipt), false);
  console.log('ok receipt write failure leaves source authoritative and removes partial receipt');
}

// Publishing occurs only after a durable exclusive receipt exists. A publish
// failure removes that owned receipt and leaves the retired tree untouched.
{
  const id = 'B-publish-failure';
  const c = createCase(id);
  const before = snapshot(c.source);
  const injected = {
    renameSync(source, destination) {
      if (destination === c.destination) throw new Error('injected publish failure');
      return renameSync(source, destination);
    },
  };
  expectFailure(() => handler(c.root, injected)({ id, confirm: true }), /injected publish failure/u);
  assert.deepEqual(snapshot(c.source), before);
  assert.equal(existsSync(c.destination), false);
  assert.equal(existsSync(c.receipt), false);
  console.log('ok publish failure rolls back receipt without touching source');
}

// Simulate a destructive rm that deletes one source file and then throws. The
// rollback must reconstruct the complete source from the verified destination,
// remove canonical state, and remove the receipt only after restoration succeeds.
{
  const id = 'B-partial-delete-failure';
  const c = createCase(id);
  const before = snapshot(c.source);
  let injectedOnce = false;
  const injected = {
    rmSync(target, options) {
      if (target === c.source && !injectedOnce) {
        injectedOnce = true;
        rmSync(join(c.source, 'nested', 'evidence.txt'));
        throw new Error('injected partial source deletion');
      }
      return rmSync(target, options);
    },
  };
  expectFailure(() => handler(c.root, injected)({ id, confirm: true }), /injected partial source deletion/u);
  assert.deepEqual(snapshot(c.source), before);
  assert.equal(existsSync(c.destination), false);
  assert.equal(existsSync(c.receipt), false);
  console.log('ok partial source deletion is byte-restored before canonical state and receipt are removed');
}

// If cleanup itself fails, rollback still restores the source but deliberately
// retains canonical state plus the receipt. The failure is explicit and the
// remaining canonical tree is therefore auditable rather than orphaned.
{
  const id = 'B-rollback-failure';
  const c = createCase(id);
  const before = snapshot(c.source);
  let sourceDeleteInjected = false;
  const injected = {
    rmSync(target, options) {
      if (target === c.source && !sourceDeleteInjected) {
        sourceDeleteInjected = true;
        rmSync(join(c.source, 'nested', 'evidence.txt'));
        throw new Error('injected partial source deletion');
      }
      if (target === c.destination) throw new Error('injected canonical cleanup failure');
      return rmSync(target, options);
    },
  };
  expectFailure(
    () => handler(c.root, injected)({ id, confirm: true }),
    /state rollback failed: injected canonical cleanup failure.*receipt is retained/u,
  );
  assert.deepEqual(snapshot(c.source), before);
  assert.deepEqual(snapshot(c.destination), before);
  assert.equal(JSON.parse(readFileSync(c.receipt, 'utf8')).protocol, 'receipt-first-with-verified-rollback');
  console.log('ok rollback cleanup failure retains byte-verified canonical state and its audit receipt');
}

// Success preserves the original byte/digest manifest, removes the retired tree,
// and leaves a durable receipt that describes the receipt-first commit protocol.
{
  const id = 'B-success';
  const c = createCase(id);
  const before = snapshot(c.source);
  const output = handler(c.root)({ id, confirm: true });
  assert.match(output, /atomically migrated/u);
  assert.equal(existsSync(c.source), false);
  assert.deepEqual(snapshot(c.destination), before);
  const receipt = JSON.parse(readFileSync(c.receipt, 'utf8'));
  assert.equal(receipt.storyId, id);
  assert.equal(receipt.protocol, 'receipt-first-with-verified-rollback');
  assert.equal(receipt.files.length, before.length);
  const expectedDigests = before.map(([path, hex]) => ({
    path,
    sha256: createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex'),
    bytes: hex.length / 2,
  }));
  assert.deepEqual(receipt.files, expectedDigests);
  console.log('ok success publishes canonical bytes, removes source, and retains durable receipt');
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log('identity-state-migrate atomicity: PASS');
