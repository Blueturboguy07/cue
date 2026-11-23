const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { giveUpTimer } = require('../src/give-up');
const { MODES } = require('../src/prompts');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

function renderMarkdown() {
  const start = rendererSrc.indexOf('  function renderMarkdown(text) {');
  const end = rendererSrc.indexOf('\n  }\n', start);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return new Function('esc', rendererSrc.slice(start, end + 4) + '; return renderMarkdown;')(esc);
}

test('markdown: headings, numbered lists and italics render; raw "##" and "1." no longer show', () => {
  const html = renderMarkdown()('## Approach\nUse a *hash map*.\n1. Count\n2. Scan\n- a bullet');
  assert.match(html, /<p class="md-h"><strong>Approach<\/strong><\/p>/);
  assert.match(html, /<em>hash map<\/em>/);
  assert.match(html, /<ol><li>Count<\/li><li>Scan<\/li><\/ol><ul><li>a bullet<\/li><\/ul>/);
  assert.ok(!html.includes('##'));
});

test('markdown: maths in $…$ shows as code, money amounts and snake_case stay as written, HTML is escaped', () => {
  const html = renderMarkdown()('$O(n^2)$ time; range $120k to $140k; snake_case_name; <b>x</b>');
  assert.match(html, /<code>O\(n\^2\)<\/code>/);
  assert.match(html, /range \$120k to \$140k/);
  assert.match(html, /snake_case_name/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('give-up timer: cancel() rejects with `cancelled` and aborts the request', async () => {
  const guard = giveUpTimer(60000, 'timed out');
  guard.cancel();
  await assert.rejects(guard.expired, (e) => e.cancelled === true);
  assert.equal(guard.signal.aborted, true);
});

test('answers: grounded in the résumé, short and speakable', () => {
  for (const mode of ['answerThis', 'say', 'ask', 'assist']) {
    const system = MODES[mode].buildSystem('', '');
    assert.match(system, /Never invent projects, companies, metrics or technologies/, `${mode} must not invent experience`);
  }
  for (const mode of ['answerThis', 'say']) {
    const system = MODES[mode].buildSystem('', '');
    assert.match(system, /Under 90 words/, `${mode} answers stay short`);
    assert.match(system, /2–4 bullet points/, `${mode} answers are points to say`);
  }
});

test('mic filter: lines invented from a quiet room are dropped, real English lines kept (smoke test lines)', () => {
  const { isLikelyInventedMicLine } = require('../src/transcript-filter');
  for (const invented of [
    'Chị nhìn là vô liền.',
    'Olá! Sou a professora Danielle Ribeiro e a gente vai conversar hoje sobre a temática do ensino de leitura e produção textual na educação básica.',
    'Thanks for watching!',
    'Subtitles by the Amara.org community'
  ]) assert.equal(isLikelyInventedMicLine(invented), true, invented);
  for (const said of [
    'Mm-hmm, okay, yeah.',
    'During my internship at Nubes Opus, I built an NLP pipeline.',
    'Naïve Bayes was my baseline for the classifier.',
    'I worked on the café’s ordering app with my team.',
    'Oui.'
  ]) assert.equal(isLikelyInventedMicLine(said), false, said);
});
