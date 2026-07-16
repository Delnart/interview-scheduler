// Serializes async work per slot id within this process, so background jobs that
// touch the same slot (Google event swap, rebook-cancel, event-id bookkeeping)
// never interleave. Returns fn's promise; errors propagate to the caller but
// never break the chain.
// ponytail: in-process lock — single backend instance. Move to pg advisory locks
// if the backend ever scales horizontally.
const chains = new Map();

module.exports = function withSlotLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
};
