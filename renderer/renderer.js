/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = cue.platform === 'win32';
  const isMac = cue.platform === 'darwin';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  $('#quit-btn').innerHTML = icon('x', { size: 14 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let appMode = 'interview';
  let whisperOverview = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    // Guard: caretEl must be a child of aiEl
    if (caretEl && caretEl.parentNode === aiEl) {
      aiEl.insertBefore(span, caretEl);
    } else {
      aiEl.appendChild(span);
    }
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    clearTimeout(busyFailsafe);
    // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
    // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
    if (v) busyFailsafe = setTimeout(() => { busy = false; $('#send-btn').classList.toggle('busy', false); }, 40000);
  }

  // ---- transcript helpers ------------------------------------------------
  // NOTE: The old transcript-list element was renamed to ts-list.
  // These helpers are now deprecated but kept for compatibility.
  // The main sidebar uses appendTranscriptHistoryTurn() instead.
  let transcriptInterimEl = null;

  // FIX #1: Updated to use ts-list instead of non-existent transcript-list

  function clearTranscriptInterim() {
    if (transcriptInterimEl) {
      transcriptInterimEl.remove();
      transcriptInterimEl = null;
    }
  }

  // ---- toast helper ------------------------------------------------------
  // FIX #7: Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('app').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- mode selection ----------------------------------------------------
  const modeSelectScrim = $('#mode-select-scrim');

  function showModeSelect() {
    modeSelectScrim.classList.remove('hidden');
    setIgnore(false);
    document.querySelectorAll('.mode-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.mode === appMode);
    });
  }

  async function selectMode(mode) {
    if (appMode !== null && appMode !== mode) {
      await performClearTranscript(false, false);
    }
    appMode = mode;
    settings.appMode = mode;
    await cue.settingsSet({ appMode: mode });
    applyMode(mode);
    modeSelectScrim.classList.add('hidden');
  }

  function applyMode(mode) {
    const isWork = mode === 'work';
    const actionRow = $('#action-row');

    if (isWork) {
      actionRow.innerHTML = [
        `<button class="act act-primary" data-mode="assist" title="Scans your screen and meeting audio to suggest your next response"><span class="ic" id="ic-assist"></span><span>Live Assist</span><span class="shortcut-hint" id="assist-shortcut-hint"></span></button>`,
        `<span class="sep">•</span>`,
        `<button class="act" data-mode="followup"><span class="ic" id="ic-followup"></span><span>Draft Follow-up</span></button>`,
        `<span class="sep">•</span>`,
        `<button class="act" data-mode="recap"><span class="ic" id="ic-recap"></span><span>Recap &amp; Tasks</span></button>`
      ].join('');
    } else {
      actionRow.innerHTML = [
        `<button class="act act-primary" data-mode="say" title="Suggests what to say next based on the conversation"><span class="ic" id="ic-say"></span><span>What should I say?</span><span class="shortcut-hint" id="say-shortcut-hint"></span></button>`,
        `<span class="sep">•</span>`,
        `<button class="act act-secondary" data-mode="assist" title="Scans your screen and conversation to decide what you need"><span class="ic" id="ic-assist"></span><span>Assist</span><span class="shortcut-hint" id="assist-shortcut-hint"></span></button>`,
        `<span class="sep">•</span>`,
        `<button class="act" data-mode="followup"><span class="ic" id="ic-followup"></span><span>Follow-up</span></button>`,
        `<span class="sep">•</span>`,
        `<button class="act" data-mode="recap"><span class="ic" id="ic-recap"></span><span>Recap</span></button>`
      ].join('');
    }

    // Re-paint icons after rebuilding action row
    const icMap = {
      'ic-say':        () => document.getElementById('ic-say')        && (document.getElementById('ic-say').innerHTML        = icon('wand-sparkles',  { size: 16 })),
      'ic-assist':     () => document.getElementById('ic-assist')     && (document.getElementById('ic-assist').innerHTML     = icon('sparkles',       { size: 16 })),
      'ic-followup':   () => document.getElementById('ic-followup')   && (document.getElementById('ic-followup').innerHTML   = icon('message-circle', { size: 16 })),
      'ic-recap':      () => document.getElementById('ic-recap')      && (document.getElementById('ic-recap').innerHTML      = icon('refresh-cw',     { size: 16 }))
    };
    Object.values(icMap).forEach((fn) => fn());

    // Re-bind action buttons (they were re-created)
    actionRow.querySelectorAll('.act').forEach((btn) => {
      if (btn.dataset.mode) btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
    });

    // Prep status bar
    const prepStatus = $('#prep-status');
    if (isWork) {
      prepStatus.innerHTML = [
        `<span class="prep-item" data-field="workContext">👤 Work Context</span>`,
        `<span class="prep-item" data-field="projectNotes">📁 Project Notes</span>`,
        `<span class="prep-item" data-field="meetingNotesContext">🗒️ Meeting Notes</span>`,
        `<span class="prep-item" data-field="teamRoster">👥 Team Roster</span>`
      ].join('');
    } else {
      prepStatus.innerHTML = [
        `<span class="prep-item" data-field="resume">📄 Resume</span>`,
        `<span class="prep-item" data-field="jd">💼 JD</span>`,
        `<span class="prep-item" data-field="stories">🎯 Stories</span>`,
        `<span class="prep-item" data-field="salary">💰 Salary</span>`
      ].join('');
    }

    // Settings tab visibility
    document.querySelectorAll('.s-tab-interview').forEach((t) => t.classList.toggle('hidden', isWork));
    document.querySelectorAll('.s-tab-work').forEach((t) => t.classList.toggle('hidden', !isWork));

    // Shortcut hints (they're re-created in DOM)
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';

    updatePrepStatus();

    // Toolbar mode badge
    const badge = document.getElementById('mode-badge');
    const badgeIcon = document.getElementById('mode-badge-icon');
    const badgeLabel = document.getElementById('mode-badge-label');
    if (badge && badgeIcon && badgeLabel) {
      badge.classList.remove('mode-interview', 'mode-work');
      badge.classList.add(isWork ? 'mode-work' : 'mode-interview');
      badgeIcon.textContent = isWork ? '💼 ' : '🎯 ';
      badgeLabel.textContent = isWork ? 'Work Mode' : 'Interview Mode';
    }
  }

  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => selectMode(card.dataset.mode));
  });

  const modeBadge = document.getElementById('mode-badge');
  if (modeBadge) modeBadge.addEventListener('click', () => showModeSelect());

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  // ========== SMART AUTO-FILL SYSTEM ==========
  // Track whether the current input text came from STT auto-fill (Them channel)
  let inputFromSTT = false;
  let sttFillTimer = null;
  let questionFinalizeTimer = null;
  let softClearTimer = null;
  let userSpeechStart = null;

  // Question history for undo (Ctrl+Z)
  const questionHistory = [];
  const MAX_QUESTION_HISTORY = 10;

  // ---- Question completeness detection ----
  function isLikelyCompleteQuestion(text) {
    const trimmed = (text || '').trim();
    
    // Must be substantial (not just filler words)
    if (trimmed.length < 12) return false;
    
    // High confidence: ends with question mark
    if (/\?$/.test(trimmed)) return true;
    
    // High confidence: behavioral interview patterns (these are complete even without ?)
    const behavioralPatterns = [
      /tell me about a time/i,
      /give me an example/i,
      /describe a (situation|time|project|challenge)/i,
      /walk me through/i,
      /can you (tell|describe|explain|share)/i,
      /what (was|were|is|are) your/i,
      /how (did|do|would) you/i,
      /why (did|do|are|should)/i,
      /what (did|do|would) you/i,
      /tell me about yourself/i,
      /tell me about your/i,
      /what.{1,30}(biggest|greatest|most|hardest|proudest)/i,
      /have you ever/i
    ];
    if (behavioralPatterns.some(p => p.test(trimmed))) return true;
    
    // Medium confidence: question starters with substantial content
    const questionStarters = /^(what|how|why|when|where|who|which|tell|describe|explain|can|could|would|should|have|did|do|is|are|was|were)/i;
    if (questionStarters.test(trimmed) && trimmed.length > 25) return true;
    
    // Medium confidence: ends with common question endings
    if (/(about that|for us|to us|with you|for you|about it|to share|you handle|you approach|your experience|your background)\s*$/i.test(trimmed)) return true;
    
    return false;
  }

  // ---- Get question confidence level ----
  function getQuestionConfidence(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 8) return 'low';
    if (/\?$/.test(trimmed)) return 'high';
    if (isLikelyCompleteQuestion(trimmed)) return 'medium';
    if (trimmed.length > 20) return 'accumulating';
    return 'low';
  }

  // ---- Update visual state based on question readiness ----
  // FIX #8: Batch class updates to avoid flicker
  function updateQuestionReadyState() {
    const text = input.value;
    const confidence = getQuestionConfidence(text);
    
    // Batch the class changes to minimize repaints
    const shouldBeReady = confidence === 'high' || confidence === 'medium';
    const shouldBeAccumulating = confidence === 'accumulating';
    
    // Only update if state actually changed
    const isReady = composer.classList.contains('stt-ready');
    const isAccumulating = composer.classList.contains('stt-accumulating');
    
    if (shouldBeReady !== isReady || shouldBeAccumulating !== isAccumulating) {
      composer.classList.remove('stt-ready', 'stt-accumulating');
      if (shouldBeReady) {
        composer.classList.add('stt-ready');
      } else if (shouldBeAccumulating) {
        composer.classList.add('stt-accumulating');
      }
    }
    
    updateSendButtonState(); // FIX #9: Keep send button in sync
  }
  
  // FIX #9: Send button visual "ready" state
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    
    const hasText = input.value.trim().length > 0;
    const isReady = composer.classList.contains('stt-ready');
    
    sendBtn.classList.toggle('ready', hasText && isReady);
    sendBtn.classList.toggle('has-text', hasText);
  }

  // ---- Save question to history for undo ----
  function saveToQuestionHistory(text) {
    if (!text || text.trim().length < 5) return;
    
    // Don't save duplicates
    const last = questionHistory[questionHistory.length - 1];
    if (last && last.text === text.trim()) return;
    
    questionHistory.push({
      text: text.trim(),
      timestamp: Date.now()
    });
    
    // Keep only recent history
    while (questionHistory.length > MAX_QUESTION_HISTORY) {
      questionHistory.shift();
    }
    
    updateHistoryBadge(); // FIX #14: Update badge when history changes
  }
  
  // FIX #14: History button badge showing count
  function updateHistoryBadge() {
    const historyBtn = document.getElementById('history-btn');
    if (!historyBtn) return;
    
    // Remove existing badge if any
    let badge = historyBtn.querySelector('.history-badge');
    
    const count = questionHistory.length;
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'history-badge';
        historyBtn.appendChild(badge);
      }
      badge.textContent = count > 9 ? '9+' : count;
      badge.style.display = '';
    } else if (badge) {
      badge.style.display = 'none';
    }
  }

  // ---- Restore last question from history (Ctrl+Z) ----
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (last) {
      input.value = last.text;
      inputFromSTT = true;
      lastSTTValue = last.text; // FIX #8: Track restored value for edit detection
      composer.classList.add('stt-filling');
      updateQuestionReadyState();
      syncPlaceholder();
      updateHistoryBadge(); // Update badge after removing from history
      showToast('Question restored', 1500);
      return true;
    }
    showToast('No question to restore', 1500);
    return false;
  }

  // ---- Auto-fill the input box with transcribed speech from interviewer ----
  function autoFillInputFromSTT(text) {
    // If user has manually typed something different, don't overwrite
    if (!inputFromSTT && input.value.trim().length > 0) return;

    // Cancel any pending soft-clear (interviewer is still talking)
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');

    const current = input.value.trim();
    const newText = current ? current + ' ' + text : text;
    input.value = newText;
    inputFromSTT = true;
    lastSTTValue = newText; // FIX #6: Track the STT value for edit detection
    syncPlaceholder();

    // Show filling state
    composer.classList.add('stt-filling');
    updateQuestionReadyState();
    updateSendButtonState(); // FIX #9: Update send button state

    // Reset the idle timer — after 2s of silence, check if question is complete
    clearTimeout(questionFinalizeTimer);
    questionFinalizeTimer = setTimeout(() => {
      if (isLikelyCompleteQuestion(input.value)) {
        if (settings.autoAnswer) {
          // Auto-Answer mode: instantly trigger the AI instead of waiting
          composer.classList.remove('stt-ready', 'stt-filling');
          runMode('assist', '');
        } else {
          composer.classList.add('stt-ready');
          updateSendButtonState(); // FIX #9: Update send button when ready
          // Subtle notification that question is ready
          showToast('Press Enter to answer', 2500);
        }
      }
    }, 1800);

    // After 8s of no new words, save to history and keep stable
    clearTimeout(sttFillTimer);
    sttFillTimer = setTimeout(() => {
      saveToQuestionHistory(input.value);
      composer.classList.remove('stt-filling');
      // Keep stt-ready if applicable
      updateQuestionReadyState();
      updateSendButtonState(); // FIX #9
    }, 8000);
  }

  // ---- Soft clear: don't immediately wipe question when user speaks ----
  function softClearSTTFill() {
    // When the user speaks (You channel), don't immediately clear
    // Instead, dim the input and wait — they might just be acknowledging
    if (!inputFromSTT) return;
    
    // FIX #3: Reset userSpeechStart at the beginning before setting new timestamp
    // This ensures we always track from fresh when a new soft-clear cycle begins
    const now = Date.now();
    if (!userSpeechStart) {
      userSpeechStart = now;
    }

    // Dim the input to show it's in "pending clear" state
    composer.classList.add('stt-dimmed');
    
    // Clear the finalization timer (user is responding)
    clearTimeout(questionFinalizeTimer);

    // Re-armed on every 'you' final, so this fires ~800ms after the user stops.
    // The 2s test below is measured from the FIRST final of this cycle, so a brief
    // acknowledgement ("mm-hm") leaves the question on screen while a sustained
    // answer clears it. Firing at 2.5s instead would make that test always true.
    clearTimeout(softClearTimer);
    softClearTimer = setTimeout(() => {
      const speechDuration = userSpeechStart ? Date.now() - userSpeechStart : 0;
      if (speechDuration > 2000) {
        // User has been speaking for a while — they're answering, clear the box
        saveToQuestionHistory(input.value);
        input.value = '';
        inputFromSTT = false;
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        syncPlaceholder();
        updateSendButtonState(); // FIX #9: Update send button state
        userSpeechStart = null;
      }
    }, 800);
  }

  // ---- Hard clear (called when user explicitly clears or types) ----
  // FIX #10: Add option to show toast when clearing
  function hardClearSTTFill(showUndoHint = false) {
    const hadContent = input.value.trim().length > 0;
    saveToQuestionHistory(input.value);
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear the tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    clearInputInterim(); // FIX #5: Clear interim when clearing input
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    updateHistoryBadge(); // FIX #14
    
    // FIX #10: Show undo hint when explicitly cleared
    if (showUndoHint && hadContent) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Cleared · ${undoHint}`, 2000);
    }
  }

  // ---- Reset soft-clear state (interviewer spoke again) ----
  // FIX #16: Reset userSpeechStart properly when cancelSoftClear is called
  function cancelSoftClear() {
    userSpeechStart = null; // Reset timestamp so next soft-clear starts fresh
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  
  // FIX #6: Track last STT value to detect substantial edits vs minor corrections
  let lastSTTValue = '';
  
  input.addEventListener('input', () => {
    const currentValue = input.value;
    
    // FIX #5: Clear interim text when user starts typing
    clearInputInterim();
    
    // FIX #6: Only detach from STT mode if edit is substantial
    // Minor corrections (typo fixes, small additions) should keep STT mode
    if (inputFromSTT && lastSTTValue) {
      const lengthDiff = Math.abs(currentValue.length - lastSTTValue.length);
      const isCleared = currentValue.trim().length === 0;
      const isSubstantialChange = lengthDiff > lastSTTValue.length * 0.3 || isCleared;
      
      if (isSubstantialChange) {
        // User made a major change — detach from STT mode
        saveToQuestionHistory(lastSTTValue);
        inputFromSTT = false;
        lastSTTValue = '';
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        clearTimeout(softClearTimer);
        clearTimeout(questionFinalizeTimer);
      }
      // Minor edits: keep inputFromSTT = true, just update visual state
    } else if (!inputFromSTT) {
      // User typing from scratch — standard behavior
      composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    }
    
    syncPlaceholder();
    updateSendButtonState(); // FIX #9: Update send button on input change
  });
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    const wasFromSTT = inputFromSTT;
    
    // Save to history before clearing (in case user wants to redo)
    saveToQuestionHistory(text);
    
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    // If text came from STT (interviewer question), use answerThis mode
    // Otherwise use ask mode (user typed their own question)
    runMode(wasFromSTT ? 'answerThis' : 'ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Ctrl+Z / Cmd+Z: restore last question if input is empty
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !input.value.trim()) {
      e.preventDefault();
      restoreLastQuestion();
      return;
    }
    // Escape: clear the input (with undo hint)
    if (e.key === 'Escape' && input.value.trim()) {
      e.preventDefault();
      hardClearSTTFill(true); // FIX #10: Show undo hint
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMode('assist', ''); }
  });
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A)
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
      } else if (inputFromSTT || composer.classList.contains('stt-filling')) {
        // Even if question seems incomplete, force send
        send();
      } else {
        showToast('No question to answer', 1500);
      }
    }
  });
  
  // FIX #4: Add tooltip with keyboard shortcuts to send button
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    const forceKey = isWindows ? 'Ctrl+Shift+A' : '⌘⇧A';
    sendBtn.title = `Send · ${forceKey} to force answer`;
  }

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  function toggleHide() {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      // startSystemAudio may fail (user cancels, no permission) — that's OK,
      // mic will still work and capture will toggle regardless
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  });

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript helper
  async function performClearTranscript(saveUndo = true, showToastMsg = false) {
    if (saveUndo) saveToQuestionHistory(input.value);
    
    await cue.clearTranscript();
    clearMessages();
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    transcriptInterimEl = null;
    clearTranscriptSidebar();
    hardClearSTTFill();
    
    if (showToastMsg) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Transcript cleared · ${undoHint}`, 3500);
    }
  }

  // Clear transcript button
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      await performClearTranscript(true, true);
    });
  }

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  async function startMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      cue.log('mic stream started');
      audioCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        micWorklet.port.onmessage = (e) => {
          cue.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        cue.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        cue.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cue.log('mic error: ' + message);
      showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
    }
  }
  function stopMic() {
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in cue's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the stop-btn click (fresh user gesture for getDisplayMedia) and from the
    // capture:state handler. getDisplayMedia is async, so `if (sysStream) return` alone loses the
    // race and can open a second loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    sysStarting = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      cue.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        cue.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        showStatus(cue.platform === 'win32'
          ? 'No system-audio loopback track detected. Make sure "Share audio" is checked in the screen share dialog, and that your audio device is not in exclusive mode.'
          : 'No system-audio loopback track detected. Meeting audio needs macOS 14.4+ — your screen and microphone still work.');
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          cue.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        cue.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        cue.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cue.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to cue and try again.');
    } finally {
      sysStarting = false;
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
    const labels = {
      off:          'Not listening',
      idle:         'Listening — silence detected',
      speaking:     'Speech detected',
      transcribing: 'Transcribing…'
    };
    dot.title = labels[dotState] || '';
  }

  let sttState = 'disconnected';

  function updateSttStatus({ active, streaming } = {}) {
    const label = document.getElementById('stt-status');
    if (!label) return;
    if (active === false) {
      sttState = 'disconnected';
      label.textContent = 'off';
    } else if (active === true) {
      sttState = streaming ? 'connecting' : 'batch';
      label.textContent = sttState;
    }
    label.className = 'stt-status stt-' + sttState;
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.remove('hidden');
    if (historyBtn) historyBtn.classList.add('active');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.add('sidebar-open');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.add('hidden');
    if (historyBtn) historyBtn.classList.remove('active');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.remove('sidebar-open');
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // FIX #7: Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // History button toggle
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.innerHTML = icon('message-square-text', { size: 15 });
    historyBtn.addEventListener('click', toggleSidebar);
  }

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      list.scrollTop = list.scrollHeight;
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active, streaming, mode }) => {
    setLiveDotState(active ? 'idle' : 'off');
    $('#stop-btn').classList.toggle('active', active);
    // FIX #4: Add .listening class to composer when capture is active
    composer.classList.toggle('listening', active);
    // Update history button to show active state when listening
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) {
      historyBtn.classList.toggle('listening', active);
    }
    // startSystemAudio() is called directly from the stop-button click handler
    // so that the getDisplayMedia request has a fresh user gesture.
    // Here we only start the mic (no gesture required) and stop everything on deactivate.
    if (active) {
      startMic();
      // Don't auto-open sidebar — user can toggle it manually
    } else {
      stopMic();
      stopSystemAudio();
      // FIX #2: Clear interim element when capture stops
      if (interimEl) {
        interimEl.textContent = '';
        interimEl.classList.remove('show');
      }
      // Don't auto-close sidebar — let user keep it open if they want
    }
    updateSttStatus({ active, streaming });
    // Work Mode recording indicator
    const recIndicator = document.getElementById('work-recording-indicator');
    if (recIndicator) recIndicator.classList.toggle('hidden', !(appMode === 'work' && active && settings && settings.persistTranscripts));

    if (active) { startMic(); } else { stopMic(); stopSystemAudio(); }
    if (active && mode === 'local') {
      sttState = 'local';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = 'local'; label.className = 'stt-status stt-local'; }
    } else {
      updateSttStatus({ active, streaming });
    }
  });

  // ---- real-time transcript display (interim + final) ----
  let interimEl = null;
  function getOrCreateInterimEl() {
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'interim-transcript';
      // Insert into panel-main (the left column), before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(interimEl, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(interimEl);
      } else {
        document.getElementById('panel').appendChild(interimEl);
      }
    }
    return interimEl;
  }
  // FIX #12: Show interim text in input box (grayed/italic) before final arrives
  let inputInterimEl = null;
  function showInterimInInput(text) {
    if (!inputInterimEl) {
      inputInterimEl = document.createElement('span');
      inputInterimEl.className = 'input-interim';
      // FIX #2: Insert into composer (not input-area) for correct positioning
      composer.appendChild(inputInterimEl);
    }
    inputInterimEl.textContent = text;
    inputInterimEl.style.display = text ? 'block' : 'none';
  }
  function clearInputInterim() {
    if (inputInterimEl) {
      inputInterimEl.textContent = '';
      inputInterimEl.style.display = 'none';
    }
  }
  
  cue.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    const el = getOrCreateInterimEl();
    const label = channel === 'them' ? 'Them' : 'You';
    el.textContent = `${label}: ${text}`;
    el.classList.add('show');
    appendTranscriptHistoryTurn(channel, text, true); // update sidebar interim
    
    // FIX #12: Show interviewer's interim speech in input area
    if (channel === 'them' && !input.value.trim()) {
      showInterimInInput(text);
    }
  });
  let sentimentUtteranceCount = 0;
  let analyzingSentiment = false;

  cue.on('stt:final', async ({ channel, text }) => {
    setLiveDotState('idle');
    // Clear interim when we get a final
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    clearTranscriptInterim();
    clearInputInterim(); // FIX #12: Clear interim text from input area
    // sidebar: the final turn is added via the 'transcript' event below
    
    if (window.checkStakeholderFlashcards) {
      window.checkStakeholderFlashcards(text);
    }

    if (settings.appMode === 'work' && settings.enableSentimentDetection && cue.analyzeSentiment) {
      sentimentUtteranceCount++;
      if (sentimentUtteranceCount >= 10 && !analyzingSentiment) {
        sentimentUtteranceCount = 0;
        analyzingSentiment = true;
        try {
          const recentText = transcript.slice(-15).map(t => `${t.channel === 'me' ? 'Me' : 'Speaker'}: ${t.text}`).join('\n');
          const suggestion = await cue.analyzeSentiment(recentText);
          if (suggestion && suggestion.toUpperCase() !== 'NO') {
            if (window.showToast) window.showToast(`💡 ${suggestion}`);
          }
        } catch (e) {
          console.error('[sentiment]', e);
        } finally {
          analyzingSentiment = false;
        }
      }
    }
  });
  cue.on('stt:status', ({ channel, status, provider }) => {
    cue.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    if (provider === 'local') {
      const label = document.getElementById('stt-status');
      const localLabels = {
        loading: 'loading local',
        ready: 'local',
        transcribing: 'local',
        stopping: 'stopping',
        off: 'off',
        error: 'error'
      };
      sttState = status === 'ready' || status === 'transcribing' ? 'local' : status;
      if (label) {
        label.textContent = localLabels[status] || status;
        label.className = 'stt-status stt-' + sttState;
      }
      if (status === 'loading') $('#stop-btn').classList.add('active');
      if (status === 'off' || status === 'error') $('#stop-btn').classList.remove('active');
      if (status === 'loading' || status === 'transcribing' || status === 'stopping') setLiveDotState('transcribing');
      if (status === 'ready') setLiveDotState('idle');
      if (status === 'off') setLiveDotState('off');
      return;
    }
    if (status === 'connected') {
      sttState = 'streaming';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = sttState; label.className = 'stt-status stt-streaming'; }
    }
  });
  cue.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  cue.on('llm:start', ({ userBubble, small, category }) => {
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
    group.className = 'response-group';
    const sep = document.createElement('div');
    sep.className = 'response-sep';
    sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    group.appendChild(sep);
    if (userBubble) {
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      group.appendChild(b);
    }
    if (category) {
      const pill = document.createElement('div');
      pill.className = 'category-pill';
      pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      group.appendChild(pill);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    messages.appendChild(group);
    // Use requestAnimationFrame so the DOM is fully updated before scrolling
    requestAnimationFrame(() => {
      if (sep && sep.isConnected) {
        messages.scrollTo({ top: sep.offsetTop, behavior: 'smooth' });
      }
    });
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
    // Auto-fill the input box with Them (interviewer) speech
    if (channel === 'them') {
      cancelSoftClear(); // Interviewer is speaking, cancel any pending clear
      autoFillInputFromSTT(text);
    } else {
      // User spoke — soft clear (don't immediately wipe, wait to see if they're really answering)
      softClearSTTFill();
    }
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      // Insert into panel-main before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(el, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(el);
      } else {
        document.getElementById('panel').appendChild(el);
      }
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  cue.on('status', ({ message }) => {
    cue.log('[status] ' + message);
    showStatus(message);
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) {
        sttState = 'error';
        const label = document.getElementById('stt-status');
        if (label) { label.textContent = sttState; label.className = 'stt-status stt-error'; }
      }
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  function updatePrepStatus() {
    if (!settings) return;
    const isWork = appMode === 'work';
    const fields = isWork ? {
      workContext:         !!(settings.workContext && settings.workContext.trim()),
      projectNotes:        !!(settings.projectNotes && settings.projectNotes.trim()),
      meetingNotesContext: !!(settings.meetingNotesContext && settings.meetingNotesContext.trim()),
      teamRoster:          !!(settings.teamRoster && settings.teamRoster.trim()),
      managerNotes:        !!(settings.managerNotes && settings.managerNotes.trim()),
      keyStakeholders:     !!(settings.keyStakeholders && settings.keyStakeholders.trim())
    } : {
      resume:  !!(settings.resumeText && settings.resumeText.trim()),
      jd:      !!(settings.jobDescription && settings.jobDescription.trim()),
      stories: !!(settings.starStories && settings.starStories.trim()),
      salary:  !!(settings.salaryTarget && settings.salaryTarget.trim())
    };
    document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
      const loaded = fields[el.dataset.field];
      el.classList.toggle('loaded', loaded);
      el.classList.toggle('missing', !loaded);
      el.title = loaded
        ? el.textContent.trim() + ' loaded'
        : el.textContent.trim() + ' not set — add in Settings';
    });
  }

  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = m.fast || 'fast model';
    const smart = m.smart || 'smart model';
    const btn = document.getElementById('smart-toggle');
    if (btn) btn.title = 'Fast: ' + fast + ' · Smart: ' + smart + ' (higher quality, ~2× slower)';
  }

  // ---- microphone permission banner --------------------------------------
  function showMicPermissionBanner() {
    let banner = document.getElementById('mic-perm-banner');
    if (banner) { banner.classList.add('show'); return; }
    banner = document.createElement('div');
    banner.id = 'mic-perm-banner';
    banner.className = 'show';
    banner.innerHTML =
      '<div class="mic-perm-text">' +
        '<strong>🎙️ Microphone access required</strong><br>' +
        'cue needs microphone permission to hear you during calls. Grant access in System Settings, then restart cue.' +
      '</div>' +
      '<div class="mic-perm-actions"></div>';
    const actions = banner.querySelector('.mic-perm-actions');
    if (cue.platform === 'darwin') {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open Microphone Settings';
      openBtn.addEventListener('click', () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
      actions.appendChild(openBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'dismiss';
    dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    actions.appendChild(dismissBtn);
    const panel = document.getElementById('panel');
    panel.insertBefore(banner, document.getElementById('action-row'));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() {
    fillSettings();
    scrim.classList.remove('hidden');
    refreshWhisperModels();
  }
  // Only close when the save actually succeeded, so a failed save surfaces its
  // error instead of silently discarding the user's edits.
  async function closeSettings() {
    if (await saveSettings()) scrim.classList.add('hidden');
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#quit-btn').addEventListener('click', () => { cue.quit(); });
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void closeSettings(); });

  const switchModeBtn = document.getElementById('switch-mode-btn');
  if (switchModeBtn) switchModeBtn.addEventListener('click', () => { void closeSettings().then(showModeSelect); });

  // Fill lucide icons (settings tabs, mode cards, mode-screen logo mark) — the
  // app's icon system, not emoji. Per-element size via data-ic-size.
  document.querySelectorAll('[data-ic]').forEach((el) => {
    el.innerHTML = icon(el.dataset.ic, { size: Number(el.dataset.icSize) || 16 });
  });

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      if (tab.classList.contains('on')) return;
      if (!(await saveSettings())) return;
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('on');
      const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.remove('hidden');
    });
  });

  function updateCustomProviderFields() {
    $('#custom-endpoint-settings').classList.toggle('hidden', settings.provider !== 'custom');
  }

  function fillSettings() {
    // Every panel field is mapped in renderer/settings-schema.js — one table, so
    // fill and collect cannot drift. Cross-field wiring that follows the fill:
    CueSettingsSchema.fill(document, settings);
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    updateCustomProviderFields();
    updateAiRulesCounter();
    loadSessionFiles('resume', settings.resumeFiles);
    loadSessionFiles('jd', settings.jdFiles);
    loadSessionFiles('projectNotes', settings.projectNotesFiles);
  }

  // Whoever cue has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !cue.appLinkState) return;
    let state;
    try { state = await cue.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      label.title = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await cue.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  // --- Document Import State ---
  // The textarea is the single source of truth (persisted as resumeText & co.); the
  // file list is metadata over it. Each row knows which file contributed which text,
  // so removing a row can surgically remove just that text without ever clobbering
  // pasted or previously saved content. The lists themselves are persisted too, so
  // the rows and the ✖ buttons survive an app restart.
  let sessionFiles = { projectNotes: [], resume: [], jd: [] };
  const FILE_FIELDS = {
    projectNotes: { container: '#project-notes-filename', textarea: '#project-notes', clearBtn: '#clear-project-notes-btn', label: 'Document' },
    resume: { container: '#resume-filename', textarea: '#resume-text', clearBtn: '#clear-resume-btn', label: 'Resume' },
    jd: { container: '#jd-filename', textarea: '#job-description', clearBtn: '#clear-jd-btn', label: 'Job description' }
  };

  // Remove fileText from a field value. File text is appended verbatim on import, so
  // the last occurrence is the file's own copy; if the user edited it away, the value
  // is left untouched (the row is still removed — the content is already gone).
  function removeFileText(value, fileText) {
    if (!fileText) return value;
    const idx = value.lastIndexOf(fileText);
    if (idx === -1) return value;
    const before = value.slice(0, idx).replace(/[ \t]*\n+[ \t]*$/, '');
    const after = value.slice(idx + fileText.length).replace(/^[ \t]*\n+[ \t]*/, '');
    return (before + '\n\n' + after).replace(/\n{3,}/g, '\n\n').trim();
  }

  function renderFileList(type) {
    const f = FILE_FIELDS[type];
    if (!f) return;
    const container = $(f.container);
    container.textContent = '';
    sessionFiles[type].forEach((file, i) => {
      const item = document.createElement('div');
      item.className = 's-file-item';
      const label = document.createElement('span');
      label.className = 's-file-name';
      label.textContent = '📄 ' + file.fileName;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 's-action danger';
      del.title = 'Remove this file';
      del.textContent = '✖';
      del.dataset.del = type;
      del.dataset.idx = String(i);
      item.append(label, del);
      container.appendChild(item);
    });
    syncClearButton(type);
  }

  // Keep the ✖ clear button visible whenever the field actually has content,
  // including text restored from saved settings that was never in sessionFiles.
  function syncClearButton(type) {
    const f = FILE_FIELDS[type];
    if (!f) return;
    $(f.clearBtn).classList.toggle('hidden', !$(f.textarea).value.trim().length);
  }

  function loadSessionFiles(type, list) {
    sessionFiles[type] = Array.isArray(list) ? list.map((x) => ({ fileName: x.fileName, text: x.text })) : [];
    renderFileList(type);
  }

  // One delegated listener per list container: rows are rebuilt on every render, so
  // a single container-level click handler avoids rebinding N listeners each time.
  function bindFileListContainer(type) {
    const f = FILE_FIELDS[type];
    if (!f) return;
    $(f.container).addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('button[data-del]');
      if (!btn || btn.dataset.del !== type) return;
      const idx = parseInt(btn.dataset.idx, 10);
      const file = sessionFiles[type][idx];
      if (!file) return;
      $(f.textarea).value = removeFileText($(f.textarea).value, file.text);
      sessionFiles[type].splice(idx, 1);
      renderFileList(type);
    });
  }
  bindFileListContainer('projectNotes');
  bindFileListContainer('resume');
  bindFileListContainer('jd');

  // Append imported text to the field instead of replacing it: pasted or previously
  // saved content is preserved, and a per-file row can later remove just its text.
  async function importDocuments(type) {
    const f = FILE_FIELDS[type];
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error && !res.files) { showStatus(f.label + ' import failed: ' + res.error); return; }
    const files = res.files || [];
    const errors = res.errors || [];
    if (files.length) {
      sessionFiles[type].push(...files);
      const added = files.map((x) => x.text).filter(Boolean).join('\n\n');
      const textarea = $(f.textarea);
      if (added) textarea.value = textarea.value.trim() ? textarea.value.trim() + '\n\n' + added : added;
      renderFileList(type);
    }
    if (errors.length) {
      const first = errors[0];
      showStatus(f.label + ' import: ' + files.length + ' of ' + (files.length + errors.length) + ' succeeded; ' + first.fileName + ' failed — ' + first.error);
    } else if (files.length) {
      const name = files.length > 1 ? files.length + ' files' : files[0].fileName;
      showStatus('Imported ' + name + ' — press Done to save.');
    }
  }

  const uploadProjectNotesBtn = document.getElementById('upload-project-notes-btn');
  if (uploadProjectNotesBtn) uploadProjectNotesBtn.addEventListener('click', () => void importDocuments('projectNotes'));
  const clearProjectNotesBtn = document.getElementById('clear-project-notes-btn');
  if (clearProjectNotesBtn) clearProjectNotesBtn.addEventListener('click', () => {
    sessionFiles.projectNotes = [];
    renderFileList('projectNotes');
    $('#project-notes').value = '';
  });

  const uploadResumeBtn = document.getElementById('upload-resume-btn');
  if (uploadResumeBtn) uploadResumeBtn.addEventListener('click', () => void importDocuments('resume'));
  const clearResumeBtn = document.getElementById('clear-resume-btn');
  if (clearResumeBtn) clearResumeBtn.addEventListener('click', () => {
    sessionFiles.resume = [];
    renderFileList('resume');
    $('#resume-text').value = '';
  });

  const uploadJdBtn = document.getElementById('upload-jd-btn');
  if (uploadJdBtn) uploadJdBtn.addEventListener('click', () => void importDocuments('jd'));
  const clearJdBtn = document.getElementById('clear-jd-btn');
  if (clearJdBtn) clearJdBtn.addEventListener('click', () => {
    sessionFiles.jd = [];
    renderFileList('jd');
    $('#job-description').value = '';
  });

  function statusText() {
    const k = settings.apiKeys;
    const labels = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax', azure: 'Azure AI Foundry' };
    const has = Object.keys(labels).filter((p) => k[p]).map((p) => labels[p]);
    // 'auto' walks the same fallback chain src/stt.js builds; an explicit choice
    // is reported as-is so the status line matches what will actually be used.
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.deepgram ? 'Deepgram (streaming)' : (k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : (k.gemini ? 'Gemini (batch)' : 'none')));
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    const ready = [
      settings.resumeText ? '✓ resume' : null,
      settings.jobDescription ? '✓ JD' : null,
      settings.starStories ? '✓ stories' : null,
      settings.salaryTarget ? '✓ salary' : null
    ].filter(Boolean);
    return `${labels[settings.provider] || settings.provider} · STT: ${stt}` + (ready.length ? ' · ' + ready.join(' · ') : '');
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    updateSmartTooltip();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    document.querySelectorAll('#minimax-region-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.querySelectorAll('#work-persona-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.workPersona = b.dataset.persona;
    document.querySelectorAll('#work-persona-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    document.querySelectorAll('#stt-provider-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    $('#s-status').textContent = statusText();
  }));

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await cue.whisperModels();
      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', whisperOverview.runtime.available);
      runtimeBadge.classList.toggle('error', !whisperOverview.runtime.available);
      runtimeBadge.textContent = whisperOverview.runtime.available
        ? `Ready · v${whisperOverview.runtime.version} · ${whisperOverview.runtime.target}`
        : 'Not prepared';
      runtimeBadge.title = whisperOverview.runtime.message || '';

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available
        ? 'Model files are verified before they can be loaded.'
        : whisperOverview.runtime.message;
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await cue.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model || !window.confirm(`Delete the ${model.id} model (${formatBytes(model.bytes)}) from this computer?`)) return;
    try {
      await cue.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  async function saveSettings() {
    // Collect every panel field through the same schema table fillSettings uses.
    for (const { path, value } of CueSettingsSchema.collect(document, settings)) {
      CueSettingsSchema.setPath(settings, path, value);
    }
    // Not symmetric panel fields, so outside the schema table: the whisper model
    // list is populated asynchronously by refreshWhisperModels, and the imported
    // file lists live in sessionFiles (loaded from settings in fillSettings).
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.resumeFiles = sessionFiles.resume.map((x) => ({ fileName: x.fileName, text: x.text }));
    settings.jdFiles = sessionFiles.jd.map((x) => ({ fileName: x.fileName, text: x.text }));
    settings.projectNotesFiles = sessionFiles.projectNotes.map((x) => ({ fileName: x.fileName, text: x.text }));
    try {
      settings = await cue.settingsSet(settings);
      $('#s-status').textContent = statusText();
      updatePrepStatus();
      updateSmartTooltip();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #transcript-sidebar, #settings-scrim, #onboard-scrim, #consent-scrim, #mode-select-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because cue hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    cue.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  cue.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    setIgnore(false);
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionHelp = isWindows
    ? 'cue needs permission to see and hear. Open Windows Privacy & security settings, allow <strong>Microphone</strong> and <strong>Screen recording</strong> for cue, then come back here.'
    : 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => cue.openPane('ms-settings:privacy-microphone') },
        { label: 'Open Screen recording settings', action: () => cue.openPane('ms-settings:privacy-screenrecorder') }
      ]
    : [
        { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ];
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : '<span class="kbd">⌘</span> <span class="kbd">↵</span>';
  const solveShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">H</span>' : '<span class="kbd">⌘</span> <span class="kbd">H</span>';
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>';
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.<br><br>This quick guide gets you running in about a minute.'
    },
    {
      icon: '🔐',
      title: 'Allow cue to see & hear',
      body: permissionHelp + '<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: permissionButtons
    },
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'cue uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, <span class="hl">Google Gemini</span>, or <span class="hl">Azure AI Foundry</span>. Get a key from your provider, then paste it into cue\'s Settings.<br><br><strong>Tip:</strong> For the <em>best</em> real-time listening, add a <span class="hl">Deepgram</span> key (lowest latency streaming transcription). Otherwise, an OpenAI key enables streaming via the Realtime API, and Gemini/Whisper work as batch fallbacks.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🫥',
      title: 'Stay hidden in Zoom',
      body: 'cue is hidden from most screen shares automatically (Google Meet, Teams, QuickTime — nothing to do). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong><br><br>Avoid “<strong>without</strong> window filtering” — that mode reveals cue.'
    },
    {
      icon: '✨',
      title: 'You’re all set',
      body: 'How to use cue:<ul><li>' + assistShortcut + ' — <strong>Assist</strong> with whatever\'s on screen or being said</li><li>' + solveShortcut + ' — solve a coding problem on screen</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>cue logo</strong>. Quit with ' + quitShortcut + '.'
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    const platformInfo = await cue.platformInfo();

    // Load and apply saved mode (or prompt to choose)
    if (settings.appMode) {
      appMode = settings.appMode;
      applyMode(appMode);
    } else {
      showModeSelect();
    }

    // R4: shortcut hints (applyMode also sets these, but set here as safe fallback)
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';

    // R5: prep status
    updatePrepStatus();
    // R6: smart tooltip
    updateSmartTooltip();
    // Fix 3: Adjust permission buttons based on actual Windows version.
    // ms-settings:privacy-screenrecorder only exists on Windows 11.
    // On Windows 10, screen capture needs no permission — so replace the button
    // with a more helpful note instead of an invalid settings link.
    if (isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000) {
      // Windows 10: update the onboarding screen recording button to be more helpful
      const ob = OB_STEPS[1];
      ob.buttons = ob.buttons.filter((b) => !b.label.toLowerCase().includes('screen'));
      ob.body = 'cue needs microphone permission to hear you. Click the button below to open Windows microphone settings and allow cue.<br><br><strong>Screen capture works automatically on Windows 10</strong> — no additional permission needed.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — works automatically on Windows 10</li></ul>';
    }

    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    updateHistoryBadge(); // FIX #3: Initialize badge on boot
    updateSendButtonState(); // Initialize send button state

    // Fix placeholder shortcut hint to match platform
    if (isWindows) {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">Ctrl</span><span class="keycap">⏎</span> for Assist';
    }

    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    $('#stop-btn').classList.toggle('active', st.active);
    if (!settings.onboarded) showOnboard();
  })();

  // ============================ Toasts & Flashcards ============================
  function showToast(message) {
    let container = document.querySelector('.s-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 's-toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 's-toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 4500);
  }

  const stakeholderCooldowns = {};
  
  function checkStakeholderFlashcards(text) {
    if (settings.appMode !== 'work') return;
    const mn = settings.managerNotes || '';
    const ks = settings.keyStakeholders || '';
    const combined = (mn + ' ' + ks).trim();
    if (!combined) return;
    
    const words = combined.match(/\b[A-Z][a-z]+\b/g) || [];
    const uniqueNames = [...new Set(words)].filter(w => w.length > 2);
    
    for (const name of uniqueNames) {
      const regex = new RegExp('\\b' + name + '\\b', 'i'); // case-insensitive match on transcript
      if (regex.test(text)) {
        const now = Date.now();
        if (!stakeholderCooldowns[name] || (now - stakeholderCooldowns[name] > 5 * 60 * 1000)) {
          stakeholderCooldowns[name] = now;
          let note = '';
          if (mn.includes(name)) note = mn;
          else note = ks;
          
          let preview = note.trim();
          if (preview.length > 80) preview = preview.substring(0, 80) + '...';
          showToast(`Flashcard: ${name}\n${preview}`);
          break; // Show at most one flashcard per utterance
        }
      }
    }
  }

  // Expose to window for stt:final listener to use
  window.checkStakeholderFlashcards = checkStakeholderFlashcards;
  window.showToast = showToast;

})();
