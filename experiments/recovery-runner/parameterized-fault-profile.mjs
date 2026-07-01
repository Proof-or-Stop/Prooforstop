// Explicit offline scenario-profile parsing for recovery-runner experiments.
// The fixed protocol default remains owned by run-driver.mjs.

function splitCsv(raw, label) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const parts = text.split(',').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`${label} contains an empty entry`);
  }
  return parts;
}

function requireValidScenario(id, validSet) {
  if (!validSet.has(id)) {
    throw new Error(`unknown scenario id "${id}" (valid: ${[...validSet].join(',')})`);
  }
}

function requireSafePositiveInteger(raw, scenarioId) {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid weight for ${scenarioId}: must be a positive integer`);
  }
  const weight = Number(raw);
  if (!Number.isSafeInteger(weight)) {
    throw new Error(`invalid weight for ${scenarioId}: must be a safe positive integer`);
  }
  return weight;
}

function parseListProfile(params, validSet) {
  const ids = splitCsv(params, 'list profile params');
  if (ids.length === 0) {
    throw new Error('list profile requires --scenarioParams like B1,B2,B3');
  }
  const seen = new Set();
  for (const id of ids) {
    requireValidScenario(id, validSet);
    if (seen.has(id)) {
      throw new Error(`duplicate list scenario "${id}"`);
    }
    seen.add(id);
  }
  return ids;
}

function parseWeightedProfile(params, validSet) {
  const pairs = splitCsv(params, 'weighted profile params');
  if (pairs.length === 0) {
    throw new Error('weighted profile requires --scenarioParams like B1:2,B2:1');
  }
  const seen = new Set();
  const expanded = [];
  for (const pair of pairs) {
    const parts = pair.split(':');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      throw new Error(`malformed weighted pair "${pair}" (expected scenario:positiveInteger)`);
    }
    const scenarioId = parts[0].trim();
    const weightRaw = parts[1].trim();
    requireValidScenario(scenarioId, validSet);
    if (seen.has(scenarioId)) {
      throw new Error(`duplicate weighted scenario "${scenarioId}" (combine weights in one pair)`);
    }
    seen.add(scenarioId);
    const weight = requireSafePositiveInteger(weightRaw, scenarioId);
    for (let i = 0; i < weight; i++) expanded.push(scenarioId);
  }
  return expanded;
}

export function parseScenarioProfile({
  scenarioProfile = null,
  scenarioParams = null,
  validScenarios = [],
} = {}) {
  const profile = scenarioProfile == null ? null : String(scenarioProfile).trim();
  const params = scenarioParams == null ? null : String(scenarioParams).trim();
  const validSet = new Set(validScenarios);

  if (!profile && !params) {
    return Object.freeze({ explicit: false, profile: 'fixed', scenarios: null });
  }
  if (!profile) {
    throw new Error('--scenarioParams requires --scenarioProfile list|weighted');
  }
  if (!params) {
    throw new Error(`--scenarioProfile ${profile} requires --scenarioParams`);
  }

  if (profile === 'list') {
    return Object.freeze({
      explicit: true,
      profile,
      scenarios: Object.freeze(parseListProfile(params, validSet)),
    });
  }
  if (profile === 'weighted') {
    return Object.freeze({
      explicit: true,
      profile,
      scenarios: Object.freeze(parseWeightedProfile(params, validSet)),
    });
  }

  throw new Error(`unknown --scenarioProfile "${profile}" (supported: list, weighted)`);
}

export function formatScenarioProfileLine(selection) {
  if (!selection?.explicit) return null;
  return `[run-driver] scenario profile ${selection.profile}: ${selection.scenarios.join(',')}`;
}
