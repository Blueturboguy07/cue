// New-document script for every cue page (registered from main before the first
// document loads). The launcher sets STUB_GDM to true (Mac) or false.
(() => {
  if (window.__smoke) return;
  const MARK = 'CUE_SMOKE_STUB_V1';
  const STUB_GDM = __STUB_GDM__;
  const S = window.__smoke = { mark: MARK, stubGdm: STUB_GDM, gum: 0, gdm: 0, legacy: 0, installedAt: Date.now(), href: location.href, speechStreams: 0 };
  const deny = (what) => Promise.reject(new DOMException('cue smoke test: ' + what + ' is stubbed off (' + MARK + ')', 'NotAllowedError'));

  // The mic: getUserMedia NEVER reaches the real implementation.
  const getUserMedia = function getUserMedia(constraints) {
    /* CUE_SMOKE_STUB_V1: never calls the real getUserMedia, so the mic stays off */
    S.gum++;
    S.lastGum = JSON.stringify(constraints || null).slice(0, 200);
    return deny('getUserMedia');
  };
  const md = navigator.mediaDevices;
  const proto = Object.getPrototypeOf(md);
  Object.defineProperty(proto, 'getUserMedia', { value: getUserMedia, configurable: false, writable: false });
  Object.defineProperty(md, 'getUserMedia', { value: getUserMedia, configurable: false, writable: false });
  for (const k of ['getUserMedia', 'webkitGetUserMedia']) {
    try {
      Object.defineProperty(navigator, k, {
        value: function legacyGetUserMedia() { /* CUE_SMOKE_STUB_V1 */ S.legacy++; const err = arguments[2]; if (typeof err === 'function') err(new DOMException('stubbed', 'NotAllowedError')); },
        configurable: false, writable: false,
      });
    } catch (_) {}
  }

  // Meeting audio (Mac only): the injected test speech file, never a real capture.
  if (STUB_GDM) {
    const getDisplayMedia = async function getDisplayMedia(constraints) {
      /* CUE_SMOKE_STUB_V1: returns the injected test speech stream; never a real screen or audio capture */
      S.gdm++;
      const sp = window.__smokeSpeech;
      if (!sp || !sp.b64) return deny('getDisplayMedia (no test speech loaded)');
      const rate = sp.rate || 16000;
      const bin = atob(sp.b64);
      const n = bin.length >> 1;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        if (v >= 32768) v -= 65536;
        f[i] = v / 32768;
      }
      const ctx = new AudioContext({ sampleRate: rate });
      const buf = ctx.createBuffer(1, n, rate);
      buf.copyToChannel(f, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest); // never ctx.destination: nothing reaches the speakers
      const delay = sp.delay || 1.5;
      src.start(ctx.currentTime + delay);
      S.speechStreams++;
      S.speechStartAt = Date.now() + delay * 1000;
      S.speechSeconds = n / rate;
      src.onended = () => { S.speechEndedAt = Date.now(); };
      const canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      canvas.getContext('2d').fillRect(0, 0, 2, 2);
      const v = canvas.captureStream(1).getVideoTracks()[0];
      window.__smokeSpeechCtx = ctx;
      return new MediaStream([dest.stream.getAudioTracks()[0], v]);
    };
    Object.defineProperty(proto, 'getDisplayMedia', { value: getDisplayMedia, configurable: false, writable: false });
    Object.defineProperty(md, 'getDisplayMedia', { value: getDisplayMedia, configurable: false, writable: false });
  }
})();
