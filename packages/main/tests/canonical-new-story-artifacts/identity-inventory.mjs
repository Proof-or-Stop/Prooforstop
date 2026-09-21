import { reviewedFixtureResidueAllowed } from "../../../../scripts/identity-reviewed-fixture-contexts.mjs";
import { reviewedSourceResidueAllowed } from "../../../../scripts/identity-reviewed-source-contexts.mjs";
import { reviewedDataResidueAllowed } from "../../../../scripts/identity-reviewed-json-contexts.mjs";
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { join, relative } from 'node:path';

import { identityCutoverReviewedContexts } from "../../../../scripts/verify-proof-or-stop-identity-cutover.mjs";

import ts from 'typescript';



import { IDENTITY_CUTOVER_REQUIRED_PATHS, repoRoot, promptContracts, retiredIdentityPattern, identityTextFactsCache, distRoot, HISTORICAL_SCOPE_READER_IDENTITIES, retiredProtocolStem, retiredProtocolPrefix, retiredReviewRunSalt } from "./data.mjs";
import { snapshotIdentityAuthorityState, assertIdentityAuthorityStateUnchanged } from "./public-fixtures.mjs";
import { runCli } from "./fixture-support.mjs";
import { check } from "./runner.mjs";

export function collectIdentityCutoverProductionPaths() {
  const paths = new Set(IDENTITY_CUTOVER_REQUIRED_PATHS);
  const visit = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const absolute = join(root, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|md|json)$/.test(entry.name)) paths.add(relative(repoRoot, absolute));
    }
  };
  for (const root of [
    'packages/main/src',
    'packages/main/templates/agents',
  ]) visit(join(repoRoot, root));
  return [...paths].sort();
}

export function digestWithIdentityPrefix(prefix, domain, value) {
  return createHash('sha256')
    .update(`${prefix}\0${domain}\0${promptContracts.canonicalJsonStringify(value)}`)
    .digest('hex');
}

export function reviewRunHashWithSalt(run, salt) {
  const parts = [
    run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
    run.headHash, run.materialHash, run.promptHash,
  ];
  if (run.storyFilesHash) parts.push(run.storyFilesHash);
  if (run.scopeBinding?.bindingHash) parts.push(run.scopeBinding.bindingHash);
  if (run.workspaceBinding?.bindingHash) parts.push(run.workspaceBinding.bindingHash);
  if (run.envelopeId) parts.push(run.envelopeId);
  if (run.reviewerEscalationReason) parts.push(run.reviewerEscalationReason);
  parts.push(salt);
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

export function identityLookalikes(canonical) {
  const versionMatch = canonical.match(/^(.*?)(v\d+)$/);
  assert.ok(versionMatch, `identity requires terminal version: ${canonical}`);
  return Object.freeze([
    Object.freeze({ kind: 'trailing-space', value: `${canonical} ` }),
    Object.freeze({ kind: 'case', value: canonical.replace('proof-or-stop', 'Proof-or-stop') }),
    Object.freeze({ kind: 'version', value: `${versionMatch[1]}v0` }),
    Object.freeze({ kind: 'suffix', value: `${canonical}.1` }),
    Object.freeze({ kind: 'unicode-confusable', value: canonical.replace(/v\d+$/, 'v１') }),
  ]);
}

export function assertReviewPassRejectsEnvelopeMutation({ fixture, boundaryRun, canonicalBytes, label, mutate }) {
  const envelopePath = join(fixture.storyDir, 'prompt-envelopes.json');
  const persisted = JSON.parse(canonicalBytes.toString('utf8'));
  const envelopes = persisted.envelopes.filter((candidate) => candidate.roleId === 'proof-or-stop-review-quality');
  assert.ok(envelopes.length > 0, `${label}: expected at least one persisted quality envelope`);
  for (const envelope of envelopes) mutate(envelope);
  writeFileSync(envelopePath, `${JSON.stringify(persisted, null, 2)}\n`);
  const before = snapshotIdentityAuthorityState(fixture);
  const rejected = runCli(fixture.root, 'review_pass_set', {
    storyId: fixture.storyId,
    agent: 'proof-or-stop-review-quality',
    reviewRunId: boundaryRun.reviewRunId,
    note: `Reject ${label} without persisting reviewer evidence.`,
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(rejected.status, 0, `${label}: ${rejected.stdout}${rejected.stderr}`);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /invalid|unsupported|tampered|trusted|envelope|identity|binding/i, label);
  assertIdentityAuthorityStateUnchanged(fixture, before);
  writeFileSync(envelopePath, canonicalBytes);
}

export function assertReviewPassRejectsRunMutation({ fixture, boundaryRun, canonicalBytes, label, mutate }) {
  const reviewRunsPath = join(fixture.storyDir, 'review-runs.json');
  const persisted = JSON.parse(canonicalBytes.toString('utf8'));
  const run = persisted.runs.find((candidate) => candidate.reviewRunId === boundaryRun.reviewRunId);
  assert.ok(run, `${label}: current public ReviewRun missing`);
  mutate(run);
  writeFileSync(reviewRunsPath, `${JSON.stringify(persisted, null, 2)}\n`);
  const before = snapshotIdentityAuthorityState(fixture);
  const rejected = runCli(fixture.root, 'review_pass_set', {
    storyId: fixture.storyId,
    agent: 'proof-or-stop-review-quality',
    reviewRunId: run.reviewRunId,
    note: `Reject ${label} without persisting reviewer evidence.`,
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(rejected.status, 0, `${label}: ${rejected.stdout}${rejected.stderr}`);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /invalid|signature|tampered|review run|identity|binding|prompt/i, label);
  assertIdentityAuthorityStateUnchanged(fixture, before);
  writeFileSync(reviewRunsPath, canonicalBytes);
}

export function identityCutoverSourceMap(paths = collectIdentityCutoverProductionPaths()) {
  return new Map(paths.map((path) => [path, readFileSync(join(repoRoot, path), 'utf8')]));
}

export function createIdentityTextFactsCache() {
  const entries = new Map();
  let analyses = 0;
  let tokenAnalyses = 0;
  let requestedTokens = new Map();
  return {
    prepare(sourceMap, rows = []) {
      for (const path of entries.keys()) if (!sourceMap.has(path)) entries.delete(path);
      requestedTokens = new Map();
      for (const row of rows) {
        const tokens = requestedTokens.get(row.path) ?? new Set();
        tokens.add(row.token);
        requestedTokens.set(row.path, tokens);
      }
      for (const [path, entry] of entries) {
        for (const token of entry.tokens.keys()) {
          if (!requestedTokens.get(path)?.has(token)) entry.tokens.delete(token);
        }
      }
    },
    get(path, source) {
      assert.equal(typeof source, 'string', 'identity facts require exact primitive source text');
      let entry = entries.get(path);
      if (!entry || entry.source !== source) {
        analyses++;
        const lines = Object.freeze(source.split(/\r?\n/));
        const hits = [];
        let line = 1;
        let cursor = 0;
        for (const match of source.matchAll(new RegExp(retiredIdentityPattern.source, retiredIdentityPattern.flags))) {
          let newline;
          while ((newline = source.indexOf('\n', cursor)) !== -1 && newline < match.index) {
            line++;
            cursor = newline + 1;
          }
          hits.push(Object.freeze({ path, line, token: match[0] }));
        }
        entry = { source, tokens: new Map(), facts: Object.freeze({
          lines,
          hits: Object.freeze(hits),
          sha256: createHash('sha256').update(source).digest('hex'),
        }) };
        entries.set(path, entry);
      }
      return entry.facts;
    },
    token(path, source, token) {
      const facts = this.get(path, source);
      const entry = entries.get(path);
      if (entry.tokens.has(token)) return entry.tokens.get(token);
      tokenAnalyses++;
      const result = Object.freeze({
        count: source.split(token).length - 1,
        contextSha256: createHash('sha256').update(facts.lines.filter(line => line.includes(token)).join('\n')).digest('hex'),
      });
      if (requestedTokens.get(path)?.has(token)) entry.tokens.set(token, result);
      return result;
    },
    stats() {
      return { analyses, tokenAnalyses, entries: entries.size,
        tokens: [...entries.values()].reduce((sum, entry) => sum + entry.tokens.size, 0) };
    },
  };
}

export function retiredProtocolHits(sourceMap, cache = identityTextFactsCache) {
  return [...sourceMap].flatMap(([path, source]) => cache.get(path, source).hits);
}

export function assertIdentityCutoverInventoryTotal(sourceMap, { reviewed = identityCutoverReviewedContexts(), cache = identityTextFactsCache } = {}) {
  const rows = reviewed.rows.filter(row => sourceMap.has(row.path));
  const exactReviewedRows = ['source', 'json', 'fixture'].flatMap(kind => JSON.parse(readFileSync(join(repoRoot, `scripts/identity-reviewed-${kind}-data.json`), 'utf8')).entries);
  cache.prepare(sourceMap, rows);
  for (const requiredPath of IDENTITY_CUTOVER_REQUIRED_PATHS) {
    assert.equal(sourceMap.has(requiredPath), true, `identity inventory missing required path ${requiredPath}`);
  }
  assert.ok(sourceMap.size > IDENTITY_CUTOVER_REQUIRED_PATHS.length, 'identity inventory must recursively discover active source');
  const retiredHits = retiredProtocolHits(sourceMap, cache);
  for (const [path, token, expectedOccurrences] of HISTORICAL_SCOPE_READER_IDENTITIES) {
    assert.equal(
      retiredHits.filter((hit) => hit.path === path && hit.token === token).length,
      expectedOccurrences,
      `historical scope reader identity row drifted: ${path}:${token}`,
    );
  }
  const allowed = new Set(HISTORICAL_SCOPE_READER_IDENTITIES.map(([path, token]) => `${path}\0${token}`));
  // Share the scanner's independently reviewed denial/migration inventory, but
  // check it against THIS map, including synthetic mutations, not disk alone.
  // Exact full-witness hashes bind downstream rejection assertions separately
  // from the token lines. Neither kind of pin exempts the containing file.
  for (const row of rows) {
    const source = sourceMap.get(row.path);
    const facts = cache.token(row.path, source, row.token);
    assert.equal(facts.count, row.expectedOccurrences, `retired protocol identity exact count drift: ${row.path}:${row.id ?? row.token}`);
    assert.equal(facts.contextSha256, row.contextSha256, `retired protocol identity exact context drift: ${row.path}:${row.id ?? row.token}`);
  }
  for (const witness of reviewed.witnesses.filter(row => sourceMap.has(row.path))) {
    assert.equal(cache.get(witness.path, sourceMap.get(witness.path)).sha256, witness.sha256, `retired protocol identity witness integrity drift: ${witness.path}`);
  }
  // The verifier's retired-protocol role/mutation literals occur only in reviewed
  // data rows. Pin those complete lines; an added acceptance branch, duplicate,
  // altered row or relocated literal must fail, even in the verifier itself.
  const verifierPath = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
  const verifierLines = cache.get(verifierPath, sourceMap.get(verifierPath)).lines.filter(line => new RegExp(`${retiredProtocolStem}[.:\\-][a-z0-9._:-]+`, 'i').test(line));
  assert.equal(verifierLines.length, 115, 'retired protocol identity verifier data row count drift');
  assert.equal(createHash('sha256').update(verifierLines.join('\n')).digest('hex'), '18181b2a5219393f83aee1e0424f8e4c4259d558c134a06b6400ac41ab14c5f9', 'retired protocol identity verifier data context drift');
  assert.deepEqual(
    retiredHits.filter((hit) => {
      if (allowed.has(`${hit.path}\0${hit.token}`)) return false;
      const line = cache.get(hit.path, sourceMap.get(hit.path)).lines[hit.line - 1];
      const exactInput = { path: hit.path, token: hit.token, line, lineNumber: hit.line, text: sourceMap.get(hit.path) };
      const reviewedTokens = exactReviewedRows.filter(row => row.path === hit.path && (row.token.includes(hit.token) || hit.token.includes(row.token)));
      if (reviewedTokens.some(row => reviewedSourceResidueAllowed({ ...exactInput, token: row.token }) || reviewedDataResidueAllowed({ ...exactInput, token: row.token }) || reviewedFixtureResidueAllowed({ ...exactInput, token: row.token }))) return false;
      // One sentence-ending period is prose punctuation only after this exact
      // row's count/context and source witness have passed above. Keep raw hits
      // intact; this does not normalize a runtime schema or any other suffix.
      if (rows.some(row => row.path === hit.path
        && (row.token.includes(hit.token) || hit.token === `${row.token}.`)
        && line.includes(row.token))) return false;
      if (hit.path === verifierPath && verifierLines.includes(line)) return false;
      // The verifier owns exact frozen retired-brand provenance tables. It is part of
      // this inventory specifically so active proofbound protocol literals or
      // acceptance branches cannot hide behind that historical responsibility.
      if (hit.path === 'scripts/verify-proof-or-stop-identity-cutover.mjs'
        && !hit.token.toLowerCase().startsWith(retiredProtocolStem)) return false;
      return true;
    }),
    [],
    'active production/config/current-baseline source contains retired protocol identity',
  );
  assert.match(sourceMap.get('packages/main/src/core/prompt-contracts.ts'), /proof-or-stop\.digest\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/review-run.ts'), /proof-or-stop-review-run-integrity-v1/);
  assert.match(sourceMap.get('proof-or-stop.config.json'), /proof-or-stop\.prompt-envelope-rollout\.v1/);
  assert.match(sourceMap.get('docs/requirements/baselines/role-prompt-measurement-baseline.json'), /proof-or-stop\.prompt-measurement\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/prompt-registry.ts'), /proof-or-stop\.prompt-registry\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/claim-admissibility/pack-framework.ts'), /proof-or-stop\.claim_admissibility_pack\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/claim-admissibility/pack-framework.ts'), /domain: 'proof-or-stop-code-runtime'/);
  assert.match(sourceMap.get('scripts/verify-proof-or-stop-identity-cutover.mjs'), /proof-or-stop\.artifact-release\.v1/);
  assert.match(sourceMap.get('scripts/verify-proof-or-stop-identity-cutover.mjs'), /proof-or-stop\.product-capability-release\.v1/);
  assert.match(
    sourceMap.get('packages/main/src/core/process-fact-registry.ts'),
    /Fresh rows carry exact proof-or-stop\.\* Prompt identities; retired-family rows are inert and rejected by active readers/,
  );
}

export async function runCases() {
await check(['identity-cutover'], 'runtime tracer preserves exact observations without linear membership scans', () => {
  const result = spawnSync(process.execPath, [join(distRoot, 'tasks', 'validation-runtime-tracer-transparency-smoke.js')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /validation runtime tracer promisify transparency smoke PASS/);
});

await check(['identity-cutover', 'identity-inventory', 'identity-cache'], 'identity text-fact cache is byte-exact bounded and equivalent to uncached text analysis', () => {
  const cache = createIdentityTextFactsCache();
  const token = `${retiredProtocolPrefix}cache-control.v1`;
  const original = `Unicode Ω\r\n${token} ${token}\nlast ${token}\r\n`;
  const sources = new Map([['a.ts', original], ['b.ts', 'canonical only\n']]);
  const rows = [{ path: 'a.ts', token }];
  const uncachedHits = (path, source) => [...source.matchAll(new RegExp(retiredIdentityPattern.source, retiredIdentityPattern.flags))]
    .map(match => ({ path, line: source.slice(0, match.index).split('\n').length, token: match[0] }));
  const assertReference = () => {
    cache.prepare(sources, rows);
    for (const [path, source] of sources) {
      assert.deepEqual(cache.get(path, source), {
        lines: source.split(/\r?\n/), hits: uncachedHits(path, source),
        sha256: createHash('sha256').update(source).digest('hex'),
      });
    }
    if (sources.has('a.ts')) {
      const source = sources.get('a.ts');
      assert.deepEqual(cache.token('a.ts', source, token), {
        count: source.split(token).length - 1,
        contextSha256: createHash('sha256').update(source.split(/\r?\n/).filter(line => line.includes(token)).join('\n')).digest('hex'),
      });
    }
  };
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 2, tokenAnalyses: 1, entries: 2, tokens: 1 });
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 2, tokenAnalyses: 1, entries: 2, tokens: 1 }, 'unchanged primitive bytes must not be reanalyzed');
  sources.set('a.ts', original.replace(token, 'removed-context'));
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 3, tokenAnalyses: 2, entries: 2, tokens: 1 }, 'only the changed path must be reanalyzed');
  sources.set('a.ts', original);
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 4, tokenAnalyses: 3, entries: 2, tokens: 1 }, 'restoration must replace the latest bytes, not retain every mutant');
  sources.delete('b.ts');
  sources.set('c.ts', original);
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 5, tokenAnalyses: 3, entries: 2, tokens: 1 }, 'replacement paths must evict removed entries');
  cache.prepare(sources, []);
  assert.equal(cache.stats().tokens, 0, 'token facts must be bounded to current policy requests');
  cache.prepare(new Map());
  assert.equal(cache.stats().entries, 0, 'removed source paths must not accumulate');
});

await check(['identity-cutover', 'identity-inventory'], 'CHK-007:happy:0 active producer registry config and current baselines are proof-or-stop only', () => {
  const sources = identityCutoverSourceMap();
  assertIdentityCutoverInventoryTotal(sources);
  assert.doesNotMatch(sources.get('packages/main/src/core/review-run.ts'), new RegExp(retiredReviewRunSalt));
});
}
