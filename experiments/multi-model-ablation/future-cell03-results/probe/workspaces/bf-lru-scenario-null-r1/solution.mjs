export default function createLRU(capacity) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error("capacity must be a positive integer");
  }

  const entries = new Map();

  function markUsed(key) {
    const value = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  return {
    get(key) {
      if (!entries.has(key)) {
        return undefined;
      }

      return markUsed(key);
    },

    put(key, value) {
      if (entries.has(key)) {
        entries.delete(key);
      } else if (entries.size >= capacity) {
        const leastRecentKey = entries.keys().next().value;
        entries.delete(leastRecentKey);
      }

      entries.set(key, value);
    },

    has(key) {
      return entries.has(key);
    },

    get size() {
      return entries.size;
    },

    keys() {
      return Array.from(entries.keys());
    },
  };
}
