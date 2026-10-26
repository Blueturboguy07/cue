// prompts.js — Feature definitions with interview-category-aware system prompts.
// ctx = { transcript, userText }
// System prompt receives the interview context block prepended by main.js,
// then optionally the user's AI rules appended at the end.

const { appendAiRules } = require('./profile-context');

function formatTranscript(turns, limit) {
  const recent = limit ? turns.slice(-limit) : turns;
  return recent.map((t) => (t.channel === 'them' ? 'Them: ' : 'You: ') + t.text).join('\n');
}

// Live-answer modes see only the current question thread, not the whole (possibly
// resumed) meeting: STT fragments merged into speaker utterances, from the last
// few minutes, capped — enough for a long question plus its follow-ups.
const THREAD_WINDOW_MS = 10 * 60 * 1000;
const THREAD_UTTERANCES = 8;
// A pause this long starts a new utterance, so back-to-back questions stay separate.
const UTTERANCE_GAP_MS = 3000;
function threadUtterances(turns) {
  const newest = turns.length ? turns[turns.length - 1].ts : 0;
  const merged = [];
  for (const t of turns) {
    if (newest - t.ts > THREAD_WINDOW_MS) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.channel === t.channel && t.ts - prev.ts < UTTERANCE_GAP_MS) { prev.text += ' ' + t.text; prev.ts = t.ts; }
    else merged.push({ channel: t.channel, text: t.text, ts: t.ts });
  }
  return merged.slice(-THREAD_UTTERANCES);
}
function currentThread(turns) {
  return formatTranscript(threadUtterances(turns));
}
// Puts the newest "Them" utterance on its own, so the model answers it and not
// earlier questions nobody asked cue about.
function questionThread(turns) {
  const u = threadUtterances(turns);
  const i = u.map((t) => t.channel).lastIndexOf('them');
  if (i < 0) return 'Current thread (newest last):\n' + (formatTranscript(u) || '(none)');
  const earlier = formatTranscript(u.slice(0, i));
  const since = formatTranscript(u.slice(i + 1));
  return (earlier ? 'Earlier in this thread (context only, do not answer these):\n' + earlier + '\n\n' : '') +
    'Newest question (answer only this):\n' + formatTranscript([u[i]]) +
    (since ? '\n\nSaid since then:\n' + since : '');
}
const THREAD_FOCUS = 'Answer only the newest question; use earlier lines only to understand it if it follows up on them.';

const PRACTICE_CONTEXT =
  'The user is practicing for interviews: a friend, coach or mock interviewer plays "Them", and the user wants ' +
  'to see a strong model answer in real time to compare against their own. ';

function buildSystem(base, contextBlock) {
  if (!contextBlock) return base;
  return contextBlock + '\n\n' + base;
}

// Apply AI rules to a system prompt if the mode wants them. LeetCode returns
// the prompt unchanged — code answers should stay strict regardless of how the
// user wants the AI to chat.
function applyRules(prompt, aiRules, mode) {
  if (mode === 'leetcode') return prompt;
  return appendAiRules(prompt, aiRules);
}

const BASE_RULES =
  'Always respond in clear, natural English. Never switch to Hindi or any other language unless the user explicitly asks for it. ';

const MODES = {

  // ── Assist: one-shot "do the smart thing" ─────────────────────────────────
  assist: {
    needsScreen: true,
    userBubble: null,
    small: false,
    resumeMode: 'assist',
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        'You are cue, a real-time practice copilot on the user\'s screen during interview practice or a coding session. ' +
        PRACTICE_CONTEXT +
        BASE_RULES +
        'Look at the screenshot and the recent conversation, decide what the user needs RIGHT NOW, and deliver it directly with no preamble.\n\n' +
        'Detect the question type and respond accordingly:\n' +
        '• BEHAVIORAL ("tell me about a time…"): Give a complete STAR answer (Situation, Task, Action, Result) using the candidate\'s real stories when available. Be specific, include metrics, 3–4 sentences.\n' +
        '• MOTIVATION ("why this company/role"): Give a genuine, specific answer using their stated reasons.\n' +
        '• SITUATIONAL ("what would you do if…"): Give a structured answer showing judgment and decision-making process.\n' +
        '• EXPERIENCE ("tell me about your role at X"): Draw from the resume to give a specific, proud answer.\n' +
        '• TECHNICAL/CONCEPTUAL: Explain clearly with examples. For LeetCode: short approach + solution + complexity.\n' +
        '• COMPENSATION ("salary expectations"): Use their stated target, give a confident range.\n' +
        '• "Any questions for us?": Offer 2–3 of their prepared questions.\n\n' +
        'Write in first person as if the candidate is speaking. No preamble, no "Here\'s what you could say". Just the answer.',
        contextBlock
      ), aiRules, 'assist');
    },
    build(ctx) {
      return questionThread(ctx.transcript) + '\n\n' + THREAD_FOCUS + ' Respond with exactly what I should say right now.';
    }
  },

  // ── Say: what to say next ──────────────────────────────────────────────────
  say: {
    needsScreen: false,
    userBubble: 'What should I say?',
    small: false,
    resumeMode: 'say',
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        'You are cue, an interview practice coach. ' +
        PRACTICE_CONTEXT +
        BASE_RULES +
        '"Them" is the practice interviewer; "You" is the user practicing as the candidate.\n\n' +
        'Draft ONE natural, confident model answer the candidate could say out loud, in first person.\n\n' +
        'Rules by question type:\n' +
        '• BEHAVIORAL: Use a real STAR story from their background. Situation (1 sentence) → Task (1 sentence) → Action (2–3 sentences, specific steps) → Result (1 sentence with metric if possible). Never generic.\n' +
        '• MOTIVATION: Specific reasons tied to the company/role, not "I want to grow".\n' +
        '• SITUATIONAL: Show structured thinking — "I\'d first X, then Y, because Z".\n' +
        '• EXPERIENCE: Reference the specific role/project from their resume.\n' +
        '• COMPENSATION: State the target range confidently without over-explaining.\n' +
        '• TECHNICAL: Give a clear, confident explanation. Use analogies for non-technical interviewers.\n\n' +
        'No quotes, no preamble. Write the actual words to say. 2–5 sentences.',
        contextBlock
      ), aiRules, 'say');
    },
    build(ctx) {
      return questionThread(ctx.transcript) + '\n\n' + THREAD_FOCUS + ' What should I say next?';
    }
  },

  // ── Recap ──────────────────────────────────────────────────────────────────
  recap: {
    needsScreen: false,
    userBubble: 'Recap',
    small: true,
    resumeMode: 'recap',
    transcriptRequired: true,
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        'You are cue. Recap this conversation so far, using only what is in the transcript:\n' +
        '• Topics covered — the actual subjects discussed, with the specifics (names, numbers, decisions) mentioned\n' +
        '• Questions asked — by either side, as they were phrased\n' +
        '• Key points made — what each side said or committed to\n' +
        '• Open threads — anything unresolved, unclear, or worth strengthening\n' +
        'If the context block shows this is a job interview, frame the last section as areas for the candidate to strengthen. ' +
        'Do not pad thin sections with generic filler; omit a header that has nothing real under it. ' +
        'Use short bullets under bold headers. Be concise.',
        contextBlock
      ), aiRules, 'recap');
    },
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 0);
      return 'Full transcript of the conversation:\n' + (t || '(nothing captured yet)') + '\n\nRecap this conversation.';
    }
  },

  // ── Feedback: coach the user's own attempt at the current question ─────────
  feedback: {
    needsScreen: false,
    userBubble: 'Feedback',
    small: false,
    resumeMode: 'say',
    transcriptRequired: true,
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        'You are cue, a practice coach. ' +
        PRACTICE_CONTEXT +
        BASE_RULES +
        '"Them" asks the questions; "You" lines are the user\'s own spoken attempt (speech-to-text, so ignore filler and transcription slips).\n\n' +
        'Reply with these bold sections, short bullets, no preamble:\n' +
        '**Breakdown** — 3–5 numbered steps a strong answer to the newest question would walk through, each one line.\n' +
        '**Your answer** — what landed and what was missing, vague or wrong, quoting their words where useful. ' +
        'If they have not answered yet, say so in one line and skip this section.\n' +
        '**Fix now** — the single most important change, then one tightened version of their answer in first person (2–4 sentences).',
        contextBlock
      ), aiRules, 'feedback');
    },
    build(ctx) {
      return questionThread(ctx.transcript) + '\n\nCoach my answer to the newest question.';
    }
  },

  // ── Ask: free-form question ────────────────────────────────────────────────
  ask: {
    needsScreen: true,
    userBubble: null,
    small: false,
    resumeMode: 'ask',
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        'You are cue, a real-time practice copilot with access to the user\'s screen and their practice interview. ' +
        PRACTICE_CONTEXT +
        BASE_RULES +
        'Answer the question directly and concisely. ' +
        'When the question is about the candidate\'s background, use their actual experience. ' +
        'When the question is conceptual, explain clearly with examples. No preamble.',
        contextBlock
      ), aiRules, 'ask');
    },
    build(ctx) {
      const t = currentThread(ctx.transcript);
      return (t ? 'Current question thread (newest last):\n' + t + '\n\n' : '') + 'Question: ' + ctx.userText;
    }
  },

  // ── Answer This: answer one specific transcript question ─────────────────
  answerThis: {
    needsScreen: false,
    userBubble: null,   // bubble set dynamically from the question text
    small: false,
    resumeMode: 'say',  // same context budget as 'say'
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        'You are cue, giving a model answer to ONE specific practice-interview question. ' +
        PRACTICE_CONTEXT +
        BASE_RULES +
        'The practice interviewer\'s exact question is provided below. Focus ONLY on answering that question — ignore any other conversation context.\n\n' +
        'Rules:\n' +
        '• BEHAVIORAL ("tell me about a time…"): STAR format using real stories from the candidate\'s background. Situation → Task → Action → Result. Include metrics if available.\n' +
        '• MOTIVATION ("why this company/role"): Specific, genuine reasons from their stated preferences.\n' +
        '• TECHNICAL: Clear explanation with a concrete example from their experience.\n' +
        '• EXPERIENCE: Reference specific roles/projects from their resume.\n' +
        '• COMPENSATION: State the salary target confidently in one sentence.\n' +
        '• SITUATIONAL: Structured thinking — "First I would X, then Y, because Z."\n\n' +
        'Write in first person, as the candidate speaking. No preamble. 2–5 sentences.',
        contextBlock
      ), aiRules, 'answerThis');
    },
    build(ctx) {
      // Only pass the specific question — not the full transcript history
      return 'Answer this specific interview question:\n\n"' + (ctx.userText || '(no question provided)') + '"\n\nGive the full answer the candidate should say out loud.';
    }
  },

  // ── LeetCode: pure coding solver — no personal context, no AI rules ─────
  leetcode: {
    needsScreen: true,
    userBubble: 'Solve what\'s on screen',
    small: false,
    resumeMode: 'leetcode',
    buildSystem(_contextBlock, _aiRules) {
      // Context block AND aiRules intentionally ignored — code answers must
      // stay strict regardless of personal style or context.
      return 'You are an expert competitive programmer. The screenshot contains a coding problem. ' +
        'Respond with: (1) a one-line restatement, (2) a short approach, (3) a clean, correct, idiomatic solution in a fenced code block ' +
        '(use the language shown on screen, else Python), (4) time and space complexity. Keep prose tight.';
    },
    build() { return 'Solve the coding problem shown in the screenshot.'; }
  }
};

module.exports = { MODES, formatTranscript, currentThread, questionThread };