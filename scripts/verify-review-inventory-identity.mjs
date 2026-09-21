#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { default: ts } = await import(pathToFileURL(join(root, 'node_modules/typescript/lib/typescript.js')));
const { ACTIVE_IDENTITY_OPERATION_BOUNDARIES, assertCanonicalActiveIdentityBoundary } = await import(pathToFileURL(join(root, 'packages/main/dist/core/runtime-environment-checks.js')));
const boundary = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.find(row => row.id === 'review-inventory-epoch');
assert(boundary);
const sourcePath = 'packages/main/src/core/review-inventory-epoch.ts';
const emittedPath = 'dist/core/review-inventory-epoch.js';
const bytes = readFileSync(join(root, 'packages/main', emittedPath), 'utf8');
const canonical = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(ts.createSourceFile(sourcePath, bytes, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
const digest = createHash('sha256').update(canonical).digest('hex');
const table = readFileSync(join(root, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8');
assert(table.includes(`'${sourcePath}': '${digest}'`), 'emitted syntax digest must match the reviewed pin');
assertCanonicalActiveIdentityBoundary({ boundaryId: boundary.id, projectRoot: root, runtimePackageRoot: join(root, 'packages/main') });
const scratch = mkdtempSync(join(tmpdir(), 'review-inventory-identity-'));
try {
  const paths = new Set(boundary.paths.map(row => row.path));
  for (const site of boundary.identitySites) if (site.identityOrigin) paths.add(site.identityOrigin.sourcePath.replace(/^packages\/main\/src\//, 'dist/').replace(/\.ts$/, '.js'));
  for (const path of paths) { mkdirSync(dirname(join(scratch, path)), { recursive: true }); copyFileSync(join(root, 'packages/main', path), join(scratch, path)); }
  const verify = () => assertCanonicalActiveIdentityBoundary({ boundaryId: boundary.id, projectRoot: root, runtimePackageRoot: scratch });
  verify();
  writeFileSync(join(scratch, emittedPath), bytes + '\n// Comment-only changes do not alter the executable digest.\n');
  verify();
  writeFileSync(join(scratch, emittedPath), bytes + '\nexport const unexpectedExecutableMutation = true;\n');
  assert.throws(verify, /review-inventory-epoch\.ts consumer rejected active identity bytes; executable declaration\/producer\/consumer binding changed/);
  console.log('REVIEW_REWORK_IDENTITY_BINDING PASS ' + JSON.stringify({ digest, domain: 'SHA256(TypeScript printer of emitted JS; comments removed; LF)', canonicalAccepted: true, executableMutationRejected: true }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
