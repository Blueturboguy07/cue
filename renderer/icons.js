// Inlined Lucide icon paths (MIT, lucide.dev) + cue's own logo glyph.
// icon(name, {size, stroke, fill}) -> SVG markup string.
(function () {
  const P = {
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    'wand-sparkles': '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.66a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
    'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'message-square-text': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
  };
  // Filled glyphs (no stroke)
  const FILLED = {
    play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 6 4.5z"/>',
    'stop-square': '<rect x="5" y="5" width="14" height="14" rx="3.5"/>'
  };
  // cue logo — a pinwheel/compass mark inside a ring, echoing Cluely's glyph.
  const LOGO = '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M12 12 6.5 8.2a6.6 6.6 0 0 1 5.5-2.9V12z" fill="currentColor"/>' +
    '<path d="M12 12 15.8 6.5a6.6 6.6 0 0 1 2.9 5.5H12z" fill="currentColor" opacity="0.72"/>' +
    '<path d="M12 12 17.5 15.8a6.6 6.6 0 0 1-5.5 2.9V12z" fill="currentColor" opacity="0.5"/>' +
    '<path d="M12 12 8.2 17.5a6.6 6.6 0 0 1-2.9-5.5H12z" fill="currentColor" opacity="0.85"/>' +
    '</svg>';

  // Brand logos for LLM/STT providers (simplified SVG paths)
  const BRANDS = {
    // OpenAI hexagon logo
    openai: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M22.28 9.37a5.88 5.88 0 0 0-.51-4.85 5.96 5.96 0 0 0-6.42-2.87A5.88 5.88 0 0 0 10.92.5a5.96 5.96 0 0 0-5.68 4.13 5.88 5.88 0 0 0-3.93 2.85 5.96 5.96 0 0 0 .73 6.99 5.88 5.88 0 0 0 .51 4.85 5.96 5.96 0 0 0 6.42 2.87 5.88 5.88 0 0 0 4.43 1.97 5.96 5.96 0 0 0 5.68-4.13 5.88 5.88 0 0 0 3.93-2.85 5.96 5.96 0 0 0-.73-6.81zM13.08 21.95a4.47 4.47 0 0 1-2.87-1.04l.14-.08 4.76-2.75a.77.77 0 0 0 .39-.67v-6.72l2.01 1.16a.07.07 0 0 1 .04.05v5.56a4.49 4.49 0 0 1-4.47 4.49zm-9.64-4.12a4.47 4.47 0 0 1-.54-3.01l.14.08 4.76 2.75a.77.77 0 0 0 .78 0l5.82-3.36v2.32a.07.07 0 0 1-.03.06l-4.82 2.78a4.49 4.49 0 0 1-6.11-1.62zM2.34 7.9a4.47 4.47 0 0 1 2.34-1.97v5.66a.77.77 0 0 0 .39.67l5.82 3.36-2.01 1.16a.07.07 0 0 1-.07 0L4 14a4.49 4.49 0 0 1-1.66-6.1zm16.56 3.86-5.82-3.36 2.01-1.16a.07.07 0 0 1 .07 0l4.82 2.78a4.49 4.49 0 0 1-.69 8.1v-5.69a.77.77 0 0 0-.39-.67zm2-3.02-.14-.08-4.76-2.75a.77.77 0 0 0-.78 0L9.4 9.27V6.95a.07.07 0 0 1 .03-.06l4.82-2.78a4.49 4.49 0 0 1 6.65 4.63zM8.3 12.58l-2.01-1.16a.07.07 0 0 1-.04-.05V5.81a4.49 4.49 0 0 1 7.34-3.46l-.14.08-4.76 2.75a.77.77 0 0 0-.39.67zm1.09-2.36 2.59-1.5 2.59 1.5v2.99l-2.59 1.5-2.59-1.5z"/></svg>',
    // Anthropic stylized 'A' logo
    anthropic: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.83 3h3.02l5.65 18h-3.02l-1.2-4.1h-5.56L11.5 21H8.5l5.33-18zm3.33 11.3L15 7.5l-2.16 6.8h4.32zM7.5 3H4.5l-3 18h3l3-18z"/></svg>',
    // Google Gemini star logo
    gemini: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/><path d="M12 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c1.66 0 3.16-.67 4.24-1.76l-1.42-1.42A3.96 3.96 0 0 1 12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4c1.1 0 2.1.45 2.82 1.18l1.42-1.42A5.96 5.96 0 0 0 12 6z"/><circle cx="12" cy="12" r="2"/></svg>',
    // Ollama llama silhouette
    ollama: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8.5 2 6 4.5 6 7c0 1.5.5 2.5 1.5 3.5-.5.5-1 1.5-1 2.5 0 2 1.5 3.5 3 4v3c0 .5.5 1 1 1h3c.5 0 1-.5 1-1v-3c1.5-.5 3-2 3-4 0-1-.5-2-1-2.5 1-1 1.5-2 1.5-3.5 0-2.5-2.5-5-6-5zm-2 6c-.5 0-1-.5-1-1s.5-1 1-1 1 .5 1 1-.5 1-1 1zm4 0c-.5 0-1-.5-1-1s.5-1 1-1 1 .5 1 1-.5 1-1 1z"/></svg>',
    // Groq lightning bolt
    groq: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    // Azure cloud
    azure: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6.38 6.31L1.12 18.5h4.04l.96-2.25h4.12l-4.66-9.69-.2-.25zm7.36-.31l-2.8 8.08-1.26 2.89 3.51 4.03h9.69l-4.8-5.53L22 6h-8.26zm-6.4 8.53l1.51-3.53 1.69 3.53H7.34z"/></svg>',
    // MiniMax stylized M
    minimax: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 5v14h3V9.5l3 6h2l3-6V19h3V5h-4l-3 7-3-7H3z"/></svg>',
    // Custom gear
    custom: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83"/></svg>',
    // Deepgram waveform
    deepgram: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="9" width="2" height="6" rx="1"/><rect x="6" y="6" width="2" height="12" rx="1"/><rect x="10" y="4" width="2" height="16" rx="1"/><rect x="14" y="7" width="2" height="10" rx="1"/><rect x="18" y="5" width="2" height="14" rx="1"/><rect x="22" y="10" width="2" height="4" rx="1"/></svg>',
    // Auto/magic wand
    auto: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>',
    // Local computer
    local: '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>'
  };

  function icon(name, opts) {
    opts = opts || {};
    const size = opts.size || 16;
    const stroke = opts.stroke != null ? opts.stroke : 2;
    if (name === 'logo') return LOGO.replaceAll('SIZE', size);
    // Brand logos
    if (BRANDS[name]) return BRANDS[name].replaceAll('SIZE', size);
    if (FILLED[name]) {
      return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" stroke="none" xmlns="http://www.w3.org/2000/svg">' + FILLED[name] + '</svg>';
    }
    const d = P[name] || '';
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="' + stroke + '" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' + d + '</svg>';
  }
  window.ICONS = { icon };
})();
