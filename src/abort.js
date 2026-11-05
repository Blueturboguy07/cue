// Bound our wait even when a provider ignores cancellation. The same signal
// must also reach its transport; abandoning a promise alone does not stop I/O.
function abortable(pending, signal) {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); }
    );
    if (signal.aborted) abort();
  });
}

module.exports = { abortable };
