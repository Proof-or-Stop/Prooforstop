// Lab-only reproduction of periodic model dispatch. No provider or scheduler IO.
export function alwaysWake() {
  return { wake: true, reason: 'periodic' };
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('Expected JSON facts');
}

// Input is the caller's complete semantic projection, excluding poll timestamps.
// This only decides whether to request analysis; it cannot launch work or approve gates.
export function createMonitor() {
  let previous;
  return { observe(facts) {
    let next;
    try {
      if (!facts || Object.getPrototypeOf(facts) !== Object.prototype || !Object.keys(facts).length) {
        throw new Error('Missing facts');
      }
      next = canonical(facts);
    } catch {
      previous = undefined;
      return { wake: true, reason: 'invalid_observation' };
    }
    if (next === previous) return { wake: false, reason: 'unchanged' };
    const reason = previous === undefined ? 'initialization' : 'changed';
    previous = next;
    return { wake: true, reason };
  } };
}
