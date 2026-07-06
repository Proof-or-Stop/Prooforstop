export default function createLRU(capacity) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error('capacity must be a positive integer');
  }

  const entries = new Map();

  return {
    get(key) {
      if (!entries.has(key)) {
        return undefined;
      }

      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    put(key, value) {
      if (entries.has(key)) {
        entries.delete(key);
      } else if (entries.size >= capacity) {
        const lruKey = entries.keys().next().value;
        entries.delete(lruKey);
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
