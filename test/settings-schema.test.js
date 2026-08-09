// Settings panel schema (renderer/settings-schema.js): fill/collect round-trips
// over a stub DOM, plus a drift tripwire against src/store.js defaults.
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const os = require('os');

// src/store.js requires electron at load; stub it so the schema's key names can be
// checked against the store's real defaults (the drift tripwire).
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
  return origLoad.call(this, request, parent, isMain);
};
const store = require('../src/store.js');

global.window = {};
require('../renderer/settings-schema.js');
const S = window.CueSettingsSchema;

// ---- minimal DOM stub -----------------------------------------------------
class FakeEl {
  constructor(selector) {
    this.selector = selector;
    this.value = '';
    this.checked = false;
    this.type = 'text';
    this.dataset = {};
    const set = new Set();
    this.classList = {
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
      }
    };
  }
}

function stubDom(defs) {
  const map = new Map();
  const dom = {
    querySelector(sel) {
      const v = map.get(sel);
      if (v == null) return null;
      return Array.isArray(v) ? v[0] : v;
    },
    querySelectorAll(sel) {
      const v = map.get(sel);
      if (v == null) return [];
      return Array.isArray(v) ? v : [v];
    },
    _set(sel, els) { map.set(sel, Array.isArray(els) ? els : [els]); }
  };
  if (defs) for (const [sel, els] of Object.entries(defs)) dom._set(sel, els);
  return dom;
}

function text(selector) { return new FakeEl(selector); }
function checkbox(selector) { const el = new FakeEl(selector); el.type = 'checkbox'; return el; }
function segButton(selector, attr, value) { const el = new FakeEl(selector); el.dataset[attr] = value; return el; }

function panelDom() {
  const dom = stubDom();
  dom._set('#resume-text', text('#resume-text'));
  dom._set('#job-description', text('#job-description'));
  dom._set('#key-openai', text('#key-openai'));
  dom._set('#star-stories', text('#star-stories'));
  dom._set('#whisper-language', text('#whisper-language'));
  dom._set('#whisper-threads', text('#whisper-threads'));
  dom._set('#model-fast', text('#model-fast'));
  dom._set('#model-smart', text('#model-smart'));
  dom._set('#persist-transcripts-toggle', checkbox('#persist-transcripts-toggle'));
  dom._set('#auto-answer-toggle', checkbox('#auto-answer-toggle'));
  dom._set('#provider-seg button', [
    segButton('#provider-seg button', 'provider', 'openai'),
    segButton('#provider-seg button', 'provider', 'anthropic')
  ]);
  dom._set('#work-persona-seg button', [
    segButton('#work-persona-seg button', 'persona', 'participant'),
    segButton('#work-persona-seg button', 'persona', 'host')
  ]);
  return dom;
}

function collectMap(dom, settings) {
  const out = {};
  for (const { path, value } of S.collect(dom, settings)) out[path] = value;
  return out;
}

// ---- tests ----------------------------------------------------------------
test('fill populates text fields from settings', () => {
  const dom = panelDom();
  S.fill(dom, { resumeText: 'R', jobDescription: 'JD', apiKeys: { openai: 'sk-x' } });
  assert.strictEqual(dom.querySelector('#resume-text').value, 'R');
  assert.strictEqual(dom.querySelector('#job-description').value, 'JD');
  assert.strictEqual(dom.querySelector('#key-openai').value, 'sk-x');
});

test('collect trims text fields and round-trips through fill', () => {
  const settings = { resumeText: 'R', jobDescription: 'JD', starStories: 'S' };
  const dom = panelDom();
  S.fill(dom, settings);
  dom.querySelector('#resume-text').value = '  edited  ';
  const out = collectMap(dom, settings);
  assert.strictEqual(out.resumeText, 'edited');
  assert.strictEqual(out.jobDescription, 'JD');
  assert.strictEqual(out.starStories, 'S');
});

test('checkbox fields fill and collect as booleans', () => {
  const settings = { autoAnswer: true, persistTranscripts: false };
  const dom = panelDom();
  S.fill(dom, settings);
  assert.strictEqual(dom.querySelector('#auto-answer-toggle').checked, true);
  assert.strictEqual(dom.querySelector('#persist-transcripts-toggle').checked, false);
  const out = collectMap(dom, settings);
  assert.strictEqual(out.autoAnswer, true);
  assert.strictEqual(out.persistTranscripts, false);
});

test('seg groups mark the matching button and collect the active one', () => {
  const dom = panelDom();
  S.fill(dom, { provider: 'anthropic', workPersona: 'host' });
  const buttons = dom.querySelectorAll('#provider-seg button');
  assert.strictEqual(buttons[0].classList.contains('on'), false);
  assert.strictEqual(buttons[1].classList.contains('on'), true);
  const out = collectMap(dom, { provider: 'anthropic', workPersona: 'host' });
  assert.strictEqual(out.provider, 'anthropic');
  assert.strictEqual(out.workPersona, 'host');
});

test('seg collect falls back to the existing value when nothing is active', () => {
  const dom = panelDom();
  const out = collectMap(dom, { provider: 'openai', workPersona: 'participant' });
  assert.strictEqual(out.provider, 'openai');
  assert.strictEqual(out.workPersona, 'participant');
});

test('provider-dependent model paths follow the active provider and preserve others', () => {
  const settings = {
    provider: 'anthropic',
    models: { anthropic: { fast: 'claude-a', smart: 'claude-b' }, openai: { fast: 'gpt-x', smart: 'gpt-y' } }
  };
  const dom = panelDom();
  S.fill(dom, settings);
  assert.strictEqual(dom.querySelector('#model-fast').value, 'claude-a');
  assert.strictEqual(dom.querySelector('#model-smart').value, 'claude-b');
  dom.querySelector('#model-fast').value = 'claude-new';
  const out = collectMap(dom, settings);
  assert.strictEqual(out['models.anthropic.fast'], 'claude-new');
  assert.strictEqual(out['models.anthropic.smart'], 'claude-b');
  // setPath must not clobber sibling providers
  const copy = JSON.parse(JSON.stringify(settings));
  S.setPath(copy, 'models.anthropic.fast', 'claude-new');
  assert.strictEqual(copy.models.openai.fast, 'gpt-x');
});

test('missing elements are skipped so collect never wipes what it cannot read', () => {
  const dom = stubDom(); // no fields at all
  const out = collectMap(dom, { resumeText: 'keep me' });
  assert.deepStrictEqual(out, {});
});

test('whisper language and threads keep their fallbacks and clamps', () => {
  const dom = panelDom();
  S.fill(dom, { localWhisper: {} });
  assert.strictEqual(dom.querySelector('#whisper-language').value, 'auto');
  assert.strictEqual(dom.querySelector('#whisper-threads').value, 0);
  dom.querySelector('#whisper-language').value = '';
  dom.querySelector('#whisper-threads').value = '999';
  const out = collectMap(dom, { localWhisper: {} });
  assert.strictEqual(out['localWhisper.language'], 'auto');
  assert.strictEqual(out['localWhisper.threads'], 64);
});

test('every schema field resolves to a key the store defines (drift tripwire)', () => {
  const defaults = store.getSettings();
  for (const f of S.FIELDS) {
    const path = typeof f.path === 'function' ? 'models.<provider>.fast' : f.path;
    const top = path.split('.')[0];
    assert.ok(top in defaults, `schema field '${path}' has no top-level key in store defaults`);
  }
  for (const k of ['openai', 'anthropic', 'gemini', 'deepgram', 'custom', 'ollama', 'groq', 'minimax', 'azure']) {
    assert.ok(k in defaults.apiKeys, `apiKeys.${k} missing from store defaults`);
  }
});

test('autoAnswer is a schema field (fill side was previously missing — the drift this table fixes)', () => {
  const field = S.FIELDS.find((f) => f.path === 'autoAnswer');
  assert.ok(field, 'autoAnswer must be in the schema so fill keeps the toggle in sync');
});
