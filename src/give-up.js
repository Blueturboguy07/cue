// A timer for a request cue stops waiting for. When it fires it rejects
// `expired` (the caller races it against the stream) and aborts `signal`, so
// the HTTP request is cancelled too: the provider stops generating, and
// publik stops billing, an answer nobody will see. Without the abort, a
// "timed out" answer kept streaming and was billed in full (base 0.2.10:
// "timed out" at 25 s, 700 tokens billed at 42 s).
//
//   const guard = giveUpTimer(25000, 'the model stopped responding');
//   llm.stream({ ..., signal: guard.signal });   // race against guard.expired
//   guard.rearm();   // activity: wait another 25 s (answers only)
//   guard.clear();   // the stream settled: stop the timer, keep the request
function giveUpTimer(ms, message, timers = { setTimeout, clearTimeout }) {
  const controller = new AbortController();
  let timer = null;
  let reject = () => {};
  const expired = new Promise((_res, rej) => { reject = rej; });
  expired.catch(() => {}); // a guard nobody races must not raise an unhandled rejection
  const abort = (e) => {
    clear();
    const err = e instanceof Error ? e : new Error(e || message);
    controller.abort(err);
    reject(err);
  };
  const fire = () => {
    abort(new Error(message));
  };
  const rearm = () => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(fire, ms);
  };
  const clear = () => {
    timers.clearTimeout(timer);
    timer = null;
  };
  rearm();
  return { signal: controller.signal, expired, rearm, clear, abort };
}

module.exports = { giveUpTimer };
