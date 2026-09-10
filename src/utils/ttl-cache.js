/**
 * TTL cache with a maximum size cap to prevent unbounded memory growth.
 * Uses insertion-order eviction (FIFO) when the cap is reached.
 *
 * @param {number} maxSize  Maximum number of entries before evicting the oldest.
 * @param {number} ttlMs    Time-to-live in milliseconds for each entry.
 */
function createTTLCache(maxSize = 500, ttlMs = 60_000) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  function set(key, value) {
    if (store.size >= maxSize) {
      // Evict the oldest inserted entry (Map preserves insertion order)
      store.delete(store.keys().next().value);
    }
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  function del(key) {
    store.delete(key);
  }

  function clear() {
    store.clear();
  }

  function size() {
    return store.size;
  }

  return { get, set, del, clear, size };
}

module.exports = { createTTLCache };
