/* Settings panel schema — one table mapping every settings key to its DOM field.
 *
 * fill(dom, settings)   populates the panel from settings.
 * collect(dom, settings) returns [{ path, value }] pairs to write back.
 * setPath(obj, path, value) writes one pair into the settings object.
 *
 * The store (src/store.js) owns defaults; this module owns only the DOM surface.
 * Field order matters: provider-dependent paths (models.*) must come after the
 * field that selects the provider.
 *
 * Field spec:
 *   path     — dotted path into settings, or a function(settings) => path
 *   selector — CSS selector for the element (or button group for seg fields)
 *   kind     — 'checkbox' for boolean toggles (default: text-ish input/textarea)
 *   seg      — { attr } button group; the value lives in button.dataset[attr]
 *   fill     — (el, value) => void, override the default element write
 *   collect  — (el, settings) => value, override the default element read
 */
(function () {
  const FIELDS = [
    // Keys tab
    { path: 'provider', seg: { attr: 'provider' }, selector: '#provider-seg button' },
    { path: 'apiKeys.openai', selector: '#key-openai' },
    { path: 'apiKeys.anthropic', selector: '#key-anthropic' },
    { path: 'apiKeys.gemini', selector: '#key-gemini' },
    { path: 'apiKeys.deepgram', selector: '#key-deepgram' },
    { path: 'apiKeys.custom', selector: '#key-custom' },
    { path: 'apiKeys.ollama', selector: '#key-ollama' },
    { path: 'apiKeys.groq', selector: '#key-groq' },
    { path: 'apiKeys.minimax', selector: '#key-minimax' },
    { path: 'apiKeys.azure', selector: '#key-azure' },
    { path: 'baseUrl', selector: '#base-url' },
    { path: 'azureEndpoint', selector: '#azure-endpoint' },
    { path: 'minimaxRegion', seg: { attr: 'region' }, selector: '#minimax-region-seg button' },
    // Provider-dependent — must stay after 'provider'.
    { path: (s) => 'models.' + s.provider + '.fast', selector: '#model-fast' },
    { path: (s) => 'models.' + s.provider + '.smart', selector: '#model-smart' },
    // Transcription tab
    { path: 'sttProvider', seg: { attr: 'sttProvider' }, selector: '#stt-provider-seg button' },
    { path: 'localWhisper.language', selector: '#whisper-language', fill: (el, v) => { el.value = v || 'auto'; }, collect: (el) => el.value || 'auto' },
    { path: 'localWhisper.threads', selector: '#whisper-threads', fill: (el, v) => { el.value = Number(v) || 0; }, collect: (el) => Math.max(0, Math.min(64, Number.parseInt(el.value, 10) || 0)) },
    // Profile tab
    { path: 'resumeText', selector: '#resume-text' },
    { path: 'jobDescription', selector: '#job-description' },
    // Interview Prep tab
    { path: 'starStories', selector: '#star-stories' },
    { path: 'whyCompany', selector: '#why-company' },
    { path: 'whyLeaving', selector: '#why-leaving' },
    { path: 'workStyle', selector: '#work-style' },
    // Work Context tab
    { path: 'workPersona', seg: { attr: 'persona' }, selector: '#work-persona-seg button' },
    { path: 'workContext', selector: '#work-context' },
    { path: 'projectNotes', selector: '#project-notes' },
    { path: 'meetingNotesContext', selector: '#meeting-notes-context' },
    { path: 'persistTranscripts', selector: '#persist-transcripts-toggle', kind: 'checkbox' },
    { path: 'enableSentimentDetection', selector: '#enable-sentiment-toggle', kind: 'checkbox' },
    { path: 'autoAnswer', selector: '#auto-answer-toggle', kind: 'checkbox' },
    // Team tab
    { path: 'teamRoster', selector: '#team-roster' },
    { path: 'managerNotes', selector: '#manager-notes' },
    { path: 'keyStakeholders', selector: '#key-stakeholders' },
    // Style tab
    { path: 'aiRules', selector: '#ai-rules' },
    // Q&A tab
    { path: 'salaryTarget', selector: '#salary-target' },
    { path: 'questionsToAsk', selector: '#questions-to-ask' }
  ];

  function valueAtPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = String(path).split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = value;
  }

  function defaultFill(el, value) {
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value == null ? '' : String(value);
  }

  function defaultCollect(el) {
    if (el.type === 'checkbox') return el.checked;
    return el.value.trim();
  }

  function fillField(field, dom, settings) {
    const path = typeof field.path === 'function' ? field.path(settings) : field.path;
    const value = valueAtPath(settings, path);
    if (field.seg) {
      dom.querySelectorAll(field.selector).forEach((b) => b.classList.toggle('on', b.dataset[field.seg.attr] === value));
      return;
    }
    const el = dom.querySelector(field.selector);
    if (!el) return;
    (field.fill || defaultFill)(el, value, settings);
  }

  function collectField(field, dom, settings) {
    if (field.seg) {
      const active = Array.from(dom.querySelectorAll(field.selector)).find((b) => b.classList.contains('on'));
      if (active) return active.dataset[field.seg.attr];
      return settings == null ? undefined : valueAtPath(settings, field.path);
    }
    const el = dom.querySelector(field.selector);
    if (!el) return undefined;
    return (field.collect || defaultCollect)(el, settings);
  }

  function fill(dom, settings) {
    FIELDS.forEach((f) => fillField(f, dom, settings));
  }

  function collect(dom, settings) {
    const out = [];
    FIELDS.forEach((f) => {
      const path = typeof f.path === 'function' ? f.path(settings) : f.path;
      const value = collectField(f, dom, settings);
      if (value !== undefined) out.push({ path, value });
    });
    return out;
  }

  window.CueSettingsSchema = { fill, collect, setPath, FIELDS };
})();
