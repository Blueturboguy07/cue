// Starts serialize; Stop invalidates them immediately, without waiting for a
// model or permission dialog. Only the latest requested state may take effect.
function createCaptureController({ start, stop }) {
  let desired = false;
  let controller = null;
  let tail = Promise.resolve(false);
  let pending = tail;

  function set(active) {
    if (typeof active !== 'boolean') throw new TypeError('Capture state must be a boolean.');
    if (active === desired) return pending;
    desired = active;
    if (controller) controller.abort();
    controller = active ? new AbortController() : null;

    if (!active) {
      // Invoke synchronously: input and outbound work stop before we return.
      try { pending = Promise.resolve(stop()).then(() => false); }
      catch (error) { pending = Promise.reject(error); }
      tail = Promise.allSettled([tail, pending]);
      return pending;
    }

    const current = controller;
    pending = tail.catch(() => {}).then(async () => {
      if (current.signal.aborted) return false;
      try {
        const started = await start(current.signal);
        if (current.signal.aborted) return false;
        if (!started) { desired = false; current.abort(); await stop(); }
        return !!started;
      } catch (error) {
        if (!current.signal.aborted) { desired = false; current.abort(); await stop(); }
        throw error;
      }
    });
    tail = pending;
    return pending;
  }

  return { set, toggle: () => set(!desired), get desired() { return desired; }, get signal() { return controller?.signal; } };
}

module.exports = { createCaptureController };
