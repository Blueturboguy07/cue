// Windows runner driver for the RELEASED cue 0.2.12 (cue-win-x64.exe).
//   node win-smoke.mjs a   launch cue (hooks), Sign in with publik, write the claim URL
//                          ENCRYPTED to OUT/claim/claim.enc (RSA-OAEP, the private key
//                          never leaves the Mac). The URL is never printed.
//   node win-smoke.mjs b   wait for the link, real-sound meeting audio (VB-CABLE, speech-A),
//                          End session right after the last word (stop flush + notes),
//                          What should I say?, one typed question, one screenshot
//                          question (fixed test image), quit.
// No publik key is passed in: cue mints its own install key on the runner, the way a
// user's copy does. Nothing here prints a key, a token or the claim URL.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { publicEncrypt, constants } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from './cuecdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR;
const EXE = process.env.CUE_EXE;
const PROFILE = process.env.CUE_PROFILE;
const SPEECH = process.env.SPEECH_WAV;
const PORT = 9431, IPORT = 9432;
const opts = { expectGdmStub: false };
const save = (name, v) => writeFileSync(join(OUT, name), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const log = (m) => console.log(new Date().toISOString() + ' ' + m);
const PSTATE = `(async () => { const p = await cue.publikState(); const s = await cue.settingsGet(); return { provider: s.provider, connected: p.connected, revoked: p.revoked, keyId: p.keyId, claim: (p.wallet && p.wallet.claimState) || p.claimState, line: p.line }; })()`;
const VISIBLE = `(() => { const vis = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { if (e.classList && e.classList.contains('hidden')) return false; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false; } return el.getClientRects().length > 0; };
  return { buttons: [...document.querySelectorAll('button, a, summary')].filter(vis).map((b) => ({ id: b.id || null, cls: String(b.className).slice(0, 40), text: b.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60) })),
    details: [...document.querySelectorAll('details')].map((d) => ({ id: d.id, open: d.open })), keyInputsVisible: [...document.querySelectorAll('input[type=password]')].filter(vis).length }; })()`;

async function waitAnswer(n, secs) {
  const end = Date.now() + secs * 1000;
  let last = null;
  while (Date.now() < end) {
    const list = await K.pageEval(PORT, opts, K.ANSWERS);
    last = list[n - 1];
    if (last && last.doneMs !== null) return last;
    await K.sleep(1000);
  }
  return last || { waiting: true, n };
}

async function llmRecords() {
  return K.mainEval(IPORT, `JSON.stringify(global.__smoke.llm.map((r) => ({ at: r.at, host: r.host, model: r.model, max_tokens: r.max_tokens, image: r.image, finish: r.finish, contentChars: r.contentChars, reasoningChars: r.reasoningChars, error: r.error, usage: r.usage && { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens, reasoning: r.usage.completion_tokens_details && r.usage.completion_tokens_details.reasoning_tokens } })))`).then(JSON.parse);
}

const mode = process.argv[2];
mkdirSync(OUT, { recursive: true });

if (mode === 'a') {
  const r = await K.launchCue({
    exe: EXE, profile: PROFILE, port: PORT, iport: IPORT, stubGdm: false, macHome: false,
    cfg: { testPng: join(HERE, 'test-slide.png'), stubScreenAll: false, stubScreenLarge: true, stubScreencapture: false, denyMic: false, denyDisplayMedia: false, observeLLM: true, captureExternal: true, tracePcm: true },
  });
  log('launched pid ' + r.pid + ', hooks ' + JSON.stringify(r.hooks));
  let page = null;
  for (let i = 0; i < 240 && !page; i++) { try { page = await K.pageTarget(PORT); } catch (_) { await K.sleep(250); } }
  if (!page) { log('NO INDEX PAGE'); process.exit(2); }
  await K.sleep(1500);
  const { check } = await K.confirmTarget(PORT, opts);
  const safety = await K.mainEval(IPORT, K.MAIN_SAFETY);
  log('target check ' + JSON.stringify(check));
  log('safety ' + JSON.stringify(safety));
  await K.pageEval(PORT, opts, K.LISTEN);
  const firstRun = await K.pageEval(PORT, opts, VISIBLE);
  await K.pageShot(PORT, opts, join(OUT, 'win-first-run.png'));
  let k = await K.click(PORT, opts, '.ob-cta', 'Sign in with publik');
  if (!k.clicked) k = await K.click(PORT, opts, '#setup-primary', 'Sign in with publik');
  log('sign-in click ' + JSON.stringify(k));
  let n = 0;
  for (let i = 0; i < 60 && !n; i++) { n = await K.mainEval(IPORT, 'global.__smoke.externalUrls.filter((u) => /\\/claim\\//.test(u)).length'); if (!n) await K.sleep(500); }
  if (!n) { log('NO CLAIM URL'); process.exit(3); }
  const url = await K.mainEval(IPORT, 'global.__smoke.externalUrls.filter((u) => /\\/claim\\//.test(u)).slice(-1)[0]');
  const pub = readFileSync(join(HERE, 'claim-public.pem'), 'utf8');
  const enc = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(url, 'utf8'));
  mkdirSync(join(OUT, 'claim'), { recursive: true });
  writeFileSync(join(OUT, 'claim', 'claim.enc'), enc.toString('base64'));
  const ps = await K.pageEval(PORT, opts, PSTATE);
  log('claim URL captured and encrypted (not printed); install ' + JSON.stringify({ keyId: ps.keyId, claim: ps.claim }));
  save('phase-a.json', { launched: r, check, safety, firstRun, signIn: k, publik: ps, claimUrlHost: new URL(url).host });
} else if (mode === 'b') {
  const res = { steps: [] };
  const step = (name, v) => { res.steps.push({ name, at: new Date().toISOString(), v }); log(name + ' ' + JSON.stringify(v).slice(0, 400)); };
  let ps = null;
  for (let i = 0; i < 450; i++) { ps = await K.pageEval(PORT, opts, PSTATE); if (ps.claim === 'claimed') break; await K.sleep(2000); }
  step('linked', ps);
  if (!ps || ps.claim !== 'claimed') { save('phase-b.json', res); process.exit(4); }
  for (let i = 0; i < 4; i++) {
    const v = await K.pageEval(PORT, opts, VISIBLE);
    const ob = v.buttons.find((b) => b.id === 'ob-next');
    if (!ob) break;
    step('onboarding ' + ob.text, await K.click(PORT, opts, '#ob-next', ob.text));
    await K.sleep(700);
  }
  await K.pageShot(PORT, opts, join(OUT, 'win-linked.png'));
  // Real sound: the speech plays on the default output (VB-CABLE) while cue listens.
  step('start session', await K.click(PORT, opts, '#stop-btn', 'Start session'));
  await K.sleep(3000);
  const t0 = Date.now();
  await new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${SPEECH}').PlaySync()`], { stdio: 'ignore' });
    p.on('exit', resolve);
  });
  const playEnd = Date.now();
  // End session at once: the last sentence must reach whisper through the stop flush.
  const stop = await K.click(PORT, opts, '#stop-btn', 'End session');
  step('speech played; End session pressed', { seconds: (playEnd - t0) / 1000, stopAfterPlayEndMs: Date.now() - playEnd, stop });
  let tx = [], notes = null;
  for (let i = 0; i < 60; i++) {
    const ev = await K.pageEval(PORT, opts, "(window.__ev||[]).filter((e) => e.ch === 'transcript' || e.ch === 'status' || e.ch === 'capture:state').map((e) => ({ ms: e.ms, ch: e.ch, d: e.d }))");
    tx = ev.filter((e) => e.ch === 'transcript').map((e) => e.d);
    notes = ev.find((e) => e.ch === 'status' && /Meeting notes saved/.test(e.d));
    if (notes) break;
    await K.sleep(1000);
  }
  step('transcripts', tx);
  step('notes status', notes || 'none within 60 s');
  res.stt = await K.mainEval(IPORT, '(() => ({ toggles: global.__smoke.toggles.slice(), stt: global.__smoke.stt.map((r) => ({ n: r.n, at: r.at, t: r.t, bytes: r.bytes, prompt: r.prompt.slice(0, 200), text: r.text, error: r.error, endMs: r.endMs, togglesAtStart: r.togglesAtStart })) }))()');
  res.pcmTrace = await K.mainEval(IPORT, '(() => { const T = global.__smoke.pcmTrace; return T ? { t0: T.t0, frames: T.rms.length, rms: T.rms } : null; })()');
  step('stt calls', res.stt.stt.map((r) => ({ n: r.n, sec: r.bytes / 32000, tog: r.togglesAtStart, text: r.text })));
  step('composer', await K.pageEval(PORT, opts, "({ input: document.getElementById('input').value.slice(0, 600) })"));
  step('say click', await K.click(PORT, opts, '.act[data-mode="say"]'));
  step('say answer', await waitAnswer(1, 90));
  step('clear composer', await K.pageEval(PORT, opts, "(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return i.value; })()"));
  step('type typed question', await K.typeInto(PORT, opts, '#input', 'In one sentence, what does a payment gateway do?'));
  step('send', await K.click(PORT, opts, '#send-btn'));
  step('typed answer', await waitAnswer(2, 120));
  step('type screenshot question', await K.typeInto(PORT, opts, '#input', 'Look at my screen: what revenue number and what top risk does it show?'));
  step('send', await K.click(PORT, opts, '#send-btn'));
  step('screenshot answer', await waitAnswer(3, 150));
  await K.pageShot(PORT, opts, join(OUT, 'win-answers.png'));
  step('history', await K.pageEval(PORT, opts, "[...document.querySelectorAll('#ts-list > *')].map((e) => e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 300))"));
  step('end session', await K.click(PORT, opts, '#stop-btn', 'End session'));
  await K.sleep(3000);
  res.llm = await llmRecords();
  res.answers = await K.pageEval(PORT, opts, K.ANSWERS);
  res.events = await K.pageEval(PORT, opts, "(window.__ev||[]).filter((e) => e.ch !== 'llm:token')");
  res.safety = await K.mainEval(IPORT, K.MAIN_SAFETY);
  res.rendererSmoke = JSON.parse(await K.pageEval(PORT, opts, 'JSON.stringify(window.__smoke)'));
  res.publik = await K.pageEval(PORT, opts, PSTATE);
  save('phase-b.json', res);
  try { await K.pageEval(PORT, opts, '(() => { setTimeout(() => window.cue.quit(), 100); return 1; })()'); } catch (_) {}
  await K.sleep(3000);
  log('done');
} else {
  console.log('usage: win-smoke.mjs a|b');
  process.exit(1);
}
