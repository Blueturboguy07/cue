// Two answer-area defects from the 0.2.11 smoke test:
// 1. The "TRANSCRIPTION RUNNING" label (#stt-status) sat over the first line
//    of a scrolled answer: it is drawn at top 14px with a ~11px line, and the
//    panel's content started at 20px.
// 2. #messages (max-height 50vh) did not scroll to the end of a long answer,
//    nor to the end of the honest message that replaces an empty one.
// The renderer code runs in a vm with a small fake #messages whose height
// grows with its text, as a real one does.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('vm');
const { readSource, fnFrom } = require('./source-text');

const css = readSource('renderer/styles.css');
const rendererSrc = readSource('renderer/renderer.js');
const html = readSource('renderer/index.html');

// ---- 1. the label --------------------------------------------------------

function rule(selector) {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[#.]/g, '\\$&')} \\{([^}]*)\\}`));
  assert.ok(m, `${selector} rule not found`);
  const decl = {};
  for (const part of m[1].split(';')) {
    const i = part.indexOf(':');
    if (i > 0) decl[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return decl;
}
const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim()); return m ? Number(m[1]) : NaN; };

test('the transcription label ends above the first line of the answer area', () => {
  // Both are drawn in #panel-wrap: the label first (absolute), then the panel.
  assert.match(html, /<div id="panel-wrap">\s*<span id="live-dot"[^>]*><\/span>\s*<div id="stt-status"[^>]*>[^<]*<\/div>\s*<div id="panel" /);
  assert.match(html, /<div id="panel-main">\s*<div id="messages"><\/div>/, '#messages is the first thing in the panel');
  const label = rule('#stt-status');
  assert.equal(label.position, 'absolute');
  const top = px(label.top);
  // "normal" line-height for a 9px system font is about 1.2-1.25 of the size.
  const lineHeight = label['line-height'] ? px(label['line-height']) : px(label['font-size']) * 1.25;
  const pad = rule('#panel').padding.split(/\s+/).map(px);
  const padTop = pad[0];
  const border = 1; // .glass border
  const labelBottom = top + lineHeight;
  const contentTop = border + padTop;
  assert.ok(labelBottom + 4 <= contentTop,
    `label ends at ${labelBottom}px, the answer area starts at ${contentTop}px: they overlap`);
});

// ---- 2. scroll to the end ------------------------------------------------

const LINE = 20;   // px per line of text
const CHARS = 60;  // characters per line
const INLINE = new Set(['w', 'ai-caret', 'ai-thinking']);

function makeDom() {
  let messages = null;
  class El {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.parentNode = null; this.className = '';
      this.dataset = {}; this._text = ''; this._html = ''; this.listeners = {};
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this._text = ''; this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = this.children.indexOf(ref);
      c.parentNode = this;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    remove() { const p = this.parentNode; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      for (const c of this.children) {
        if (c.className.split(/\s+/).includes(cls)) return c;
        const d = c.querySelector(sel);
        if (d) return d;
      }
      return null;
    }
    get isConnected() { let e = this; while (e.parentNode) e = e.parentNode; return e === messages; }
    get height() {
      if (INLINE.has(this.className)) return 0;
      const inlineText = this._text + this._html.replace(/<[^>]+>/g, '') +
        this.children.filter((c) => INLINE.has(c.className)).map((c) => c.textContent).join('');
      const lines = Math.ceil(inlineText.length / CHARS);
      return lines * LINE + this.children.reduce((n, c) => n + c.height, 0);
    }
    get offsetTop() {
      if (this === messages) return 0;
      let top = 0;
      let e = this;
      while (e.parentNode) {
        const p = e.parentNode;
        for (const s of p.children) { if (s === e) break; top += s.height; }
        if (p === messages) break;
        e = p;
      }
      return top;
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev); }
  }
  messages = new El('div');
  messages.clientHeight = 300;
  let top = 0;
  Object.defineProperty(messages, 'scrollHeight', { get() { return Math.max(this.clientHeight, this.children.reduce((n, c) => n + c.height, 0)); } });
  Object.defineProperty(messages, 'scrollTop', {
    get() { return top; },
    set(v) {
      const next = Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight));
      if (next === top) return;
      top = next;
      this.fire('scroll');
    }
  });
  messages.scrollTo = ({ top: t }) => { messages.scrollTop = t; };
  return { messages, createElement: (tag) => new El(tag) };
}

// The renderer's answer code: markdown, the answer bubble, the follow-the-end
// block (when there is one), and the llm:* handlers.
function answerCode() {
  const parts = [
    rendererSrc.match(/  function esc\(s\) \{[^\n]*\n/)[0],
    fnFrom(rendererSrc, '  function renderMarkdown(text) {'),
    fnFrom(rendererSrc, '  function startAi(small) {'),
    fnFrom(rendererSrc, '  function showThinking() {'),
    fnFrom(rendererSrc, '  function clearThinking() {'),
    fnFrom(rendererSrc, '  function appendToken(t) {'),
    fnFrom(rendererSrc, '  function finalizeAi() {')
  ];
  const follow = rendererSrc.indexOf('  // ---- follow the answer');
  if (follow > -1) parts.push(rendererSrc.slice(follow, rendererSrc.indexOf('\n  let busyFailsafe', follow)));
  const start = rendererSrc.indexOf("  cue.on('llm:start'");
  const end = rendererSrc.indexOf("  cue.on('transcript'", start);
  assert.ok(start > -1 && end > start, 'llm handlers not found');
  parts.push(rendererSrc.slice(start, end));
  return parts.join('\n');
}

function boot() {
  const dom = makeDom();
  const handlers = {};
  let frames = [];
  const ctx = vm.createContext({
    messages: dom.messages,
    document: { createElement: dom.createElement, getElementById: () => null },
    cue: { on: (ch, fn) => { handlers[ch] = fn; } },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setBusy: () => {}, onAnswerActivity: () => {}, showStatus: () => {}, showPublikCard: () => {},
    publikActionButton: () => null,
    Date
  });
  vm.runInContext(`let aiEl = null, caretEl = null, busy = false, responseCount = 0; const MAX_RESPONSES = 20;\n${answerCode()}`, ctx);
  const flush = () => { for (let i = 0; i < 10 && frames.length; i++) { const f = frames; frames = []; f.forEach((fn) => fn()); } };
  const fire = (ch, payload = {}) => handlers[ch](payload);
  const m = dom.messages;
  const hiddenBelow = () => m.scrollHeight - m.scrollTop - m.clientHeight;
  // An earlier answer, so the area already scrolls.
  fire('llm:start', { userBubble: 'What does a payment gateway do?' });
  for (let i = 0; i < 60; i++) fire('llm:token', { text: 'It moves card data. ' });
  fire('llm:done'); flush();
  return { fire, flush, m, hiddenBelow };
}

const words = (n) => Array.from({ length: n }, (_, i) => `word${i} `);

test('a long answer: the end stays in view while it streams and after it is done', () => {
  const { fire, flush, hiddenBelow } = boot();
  fire('llm:start', { userBubble: 'Tell me about a time you had to meet a tight deadline.' });
  flush();
  const tokens = words(400);
  for (let i = 0; i < tokens.length; i++) {
    fire('llm:token', { text: tokens[i] });
    if (i % 10 === 9) { flush(); assert.equal(hiddenBelow(), 0, `after ${i + 1} tokens, ${hiddenBelow()}px of the answer is below the edge`); }
  }
  fire('llm:done'); flush();
  assert.equal(hiddenBelow(), 0, `the end of the finished answer is ${hiddenBelow()}px below the edge`);
});

test('the honest message that replaces an empty answer is in view', () => {
  const { fire, flush, hiddenBelow } = boot();
  fire('llm:start', { userBubble: 'What should I say?' });
  flush();
  fire('llm:thinking'); flush();
  fire('llm:error', { message: 'The model used its whole length limit to think and wrote no answer. Ask again, or turn on Smart for more room.' });
  flush();
  assert.equal(hiddenBelow(), 0, `the honest message is ${hiddenBelow()}px below the edge`);
});

test('scrolling up to read stops the follow; scrolling back to the end starts it again', () => {
  const { fire, flush, m, hiddenBelow } = boot();
  fire('llm:start', { userBubble: 'Walk me through the system design.' });
  flush();
  const tokens = words(300);
  for (const t of tokens.slice(0, 150)) fire('llm:token', { text: t });
  flush();
  m.fire('wheel', { deltaY: -120 });
  m.scrollTop = m.scrollTop - 200;
  const reading = m.scrollTop;
  for (const t of tokens.slice(150, 200)) fire('llm:token', { text: t });
  flush();
  assert.equal(m.scrollTop, reading, 'the text the person reads does not move');
  m.scrollTop = m.scrollHeight; // back to the end
  for (const t of tokens.slice(200)) fire('llm:token', { text: t });
  flush();
  assert.equal(hiddenBelow(), 0, 'following again');
});
