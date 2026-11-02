// What the publik card in Settings and the first-run prompt in the overlay
// show, as pure functions over the redacted publik state (main.js
// publikState()) and the provider the renderer has selected right now.
// Loaded by index.html as a plain script (window.cuePublikCard) and by the
// unit tests through require(), so the rules are tested without a DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.cuePublikCard = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const PUBLIK = 'publik';
  // Below this, a linked account is "low": the card's one button becomes
  // "Add a plan or pack". $0.50 is about a week at the usual spend.
  const LOW_BALANCE_MICROS = 500000;

  const PROVIDER_NAMES = {
    publik: 'publik', cerebras: 'Cerebras', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini',
    deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax',
    deepseek: 'DeepSeek', azure: 'Azure AI Foundry'
  };

  const COPY = {
    lede: 'cue runs on your publik balance. You need no API key.',
    signIn: 'Sign in with publik',
    switchTo: 'Switch to publik',
    reconnect: 'Reconnect',
    addCredit: 'Add a plan or pack',
    notConnected: 'Not connected.',
    notLinked: 'This computer is not linked to your publik account yet.',
    connecting: 'Connecting…',
    byoSummary: 'Use your own API key instead'
  };

  function money(micros) {
    const n = Number(micros);
    if (micros === null || micros === undefined || micros === '' || !Number.isFinite(n)) return '';
    return n !== 0 && Math.abs(n) < 10000 ? `$${(n / 1e6).toFixed(4)}` : `$${(n / 1e6).toFixed(2)}`;
  }

  function isPublikLink(url) {
    try { return typeof url === 'string' && new URL(url).origin === 'https://publikhq.com'; } catch (_) { return false; }
  }

  function balanceOf(p) {
    const w = (p && p.wallet) || {};
    if (p && p.balanceMicros !== null && p.balanceMicros !== undefined) return Number(p.balanceMicros);
    if (w.balanceMicros !== null && w.balanceMicros !== undefined) return Number(w.balanceMicros);
    return null;
  }

  function isClaimed(p) {
    const w = (p && p.wallet) || {};
    return ((w.claimState || (p && p.claimState)) || 'anonymous') === 'claimed';
  }

  /**
   * The publik card. Exactly one primary button, chosen by state:
   *   own provider selected      → "Switch to publik"
   *   never set up               → "Sign in with publik" (opens the disclosure)
   *   set up, not linked         → "Sign in with publik" (opens the claim link)
   *   revoked / disconnected     → "Reconnect"
   *   linked, balance low        → "Add a plan or pack"
   *   linked, balance fine       → no primary; "Manage plan" stays secondary
   */
  function cardView(p, provider) {
    if (!p || !p.available) return { show: false };
    const view = { show: true, lede: COPY.lede, status: '', warn: false, primary: null, manage: null, disconnect: false };
    const live = !!(p.connected && !p.revoked);
    view.disconnect = live;
    if (provider && provider !== PUBLIK) {
      view.status = `You use your own ${PROVIDER_NAMES[provider] || provider} key now.`;
      view.primary = { kind: 'switch', label: COPY.switchTo };
      return view;
    }
    const statusText = p.status && p.status.text ? p.status.text : '';
    if (p.connected && p.revoked) {
      view.status = statusText; view.warn = true;
      view.primary = { kind: 'reconnect', label: COPY.reconnect };
      return view;
    }
    if (!p.connected) {
      if (!p.disclosureAccepted) {
        view.status = COPY.notConnected;
        view.primary = { kind: 'signin', label: COPY.signIn };
        return view;
      }
      if (p.disconnected || p.lastError) {
        view.status = statusText || COPY.notConnected; view.warn = true;
        view.primary = { kind: 'reconnect', label: COPY.reconnect };
        return view;
      }
      view.status = COPY.connecting;
      return view;
    }
    // Connected with a live key.
    if (!isClaimed(p)) {
      const url = isPublikLink(p.claimUrl) ? p.claimUrl : '';
      view.status = COPY.notLinked;
      view.primary = url ? { kind: 'link', label: COPY.signIn, url } : null;
      return view;
    }
    const w = p.wallet || {};
    const balance = balanceOf(p);
    view.status = p.line || (balance !== null ? `Linked to your publik account · ${money(balance)} left` : 'Linked to your publik account');
    const low = balance !== null && Number.isFinite(balance) && balance < LOW_BALANCE_MICROS;
    if (low) {
      const url = [p.addCreditUrl, w.addCreditUrl, p.topUpUrl, w.topUpUrl].find(isPublikLink) || 'https://publikhq.com/dashboard/api';
      view.warn = true;
      view.status = `Low balance · ${money(balance)} left.`;
      view.primary = { kind: 'credit', label: COPY.addCredit, url };
      return view;
    }
    if (p.settingsCta && isPublikLink(p.settingsCta.url)) view.manage = { label: p.settingsCta.label, url: p.settingsCta.url };
    return view;
  }

  /** True when the selected provider can answer a question now. */
  function providerReady(settings, p) {
    if (!settings) return false;
    const provider = settings.provider;
    if (provider === PUBLIK) return !!(p && p.connected && !p.revoked);
    const keys = settings.apiKeys || {};
    if (provider === 'ollama') return true;
    if (provider === 'custom') return !!settings.baseUrl;
    if (provider === 'azure') return !!(keys.azure && settings.azureEndpoint);
    return !!keys[provider];
  }

  /**
   * The first-run prompt in the overlay while nothing can answer. A build
   * with publik always points at publik first; only a build without it asks
   * for a key.
   */
  function setupPrompt(settings, p) {
    // Set up but not linked, with nothing to spend (a new computer starts at
    // $0.00): the sign-in on publikhq.com is still the next step.
    if (settings && settings.provider === PUBLIK && p && p.available && p.connected && !p.revoked && !isClaimed(p) && isPublikLink(p.claimUrl)) {
      const balance = balanceOf(p);
      if (balance === null || !Number.isFinite(balance) || balance <= 0) {
        return { title: 'Finish signing in', body: 'Sign in on publikhq.com to link this computer. cue runs on your publik balance. You need no API key.', primary: { kind: 'link', label: COPY.signIn }, secondary: null };
      }
    }
    if (providerReady(settings, p)) return null;
    if (p && p.available) {
      if (settings.provider === PUBLIK && p.disclosureAccepted && (p.revoked || p.disconnected)) {
        return { title: 'publik is disconnected', body: 'Reconnect to keep using cue. You need no API key.', primary: { kind: 'reconnect', label: COPY.reconnect }, secondary: null };
      }
      if (settings.provider === PUBLIK && p.disclosureAccepted && p.lastError) {
        return { title: 'cue could not connect to publik', body: p.lastError, primary: { kind: 'reconnect', label: COPY.reconnect }, secondary: { kind: 'byo', label: 'Use my own API key' } };
      }
      return {
        title: 'Sign in to start',
        body: COPY.lede,
        primary: { kind: settings.provider === PUBLIK ? 'signin' : 'switch', label: COPY.signIn },
        secondary: { kind: 'byo', label: 'Use my own API key' }
      };
    }
    return { title: 'Connect an AI model', body: 'Add an API key in Settings to start.', primary: { kind: 'settings', label: 'Open Settings' }, secondary: null };
  }

  return { PUBLIK, LOW_BALANCE_MICROS, PROVIDER_NAMES, COPY, cardView, providerReady, setupPrompt, money };
}));
