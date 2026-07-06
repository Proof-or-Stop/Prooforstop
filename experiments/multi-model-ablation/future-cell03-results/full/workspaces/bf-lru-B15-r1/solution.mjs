// createLRU — least-recently-used cache backed by a Map.
//
// A JS Map preserves insertion order, so we use the Map's own ordering as the recency order:
// the FIRST key in iteration order is the least-recently-used, the LAST is the most-recently-
// used. To mark an entry as "used", we delete it and re-insert it so it moves to the end.
// Both get() and put() must refresh recency this way; eviction removes the first (oldest) key.

export default function createLRU(capacity) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`createLRU: capacity must be a positive integer, got ${capacity}`);
  }

  const store = new Map();

  // Move an existing key to the most-recently-used position (end of iteration order).
  function touch(key) {
    const value = store.get(key);
    store.delete(key);
    store.set(key, value);
    return value;
  }

  function get(key) {
    if (!store.has(key)) return undefined;
    return touch(key);
  }

  function put(key, value) {
    if (store.has(key)) {
      // Update in place, then refresh recency. No eviction on update.
      store.set(key, value);
      touch(key);
      return;
    }
    if (store.size >= capacity) {
      // Evict least-recently-used = first key in iteration order.
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
    store.set(key, value); // new key inserted at the end => most-recently-used
  }

  function has(key) {
    return store.has(key);
  }

  function keys() {
    // Iteration order is LRU-first .. MRU-last, which is exactly the contract.
    return [...store.keys()];
  }

  return {
    get,
    put,
    has,
    keys,
    get size() {
      return store.size;
    },
  };
}
