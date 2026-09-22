// prompts.js — Feature definitions with call-aware system prompts for a Miter
// sales / customer-success rep on a live call.
// ctx = { transcript, userText }
// System prompt receives the call-context block (playbook + retrieved
// knowledge-base excerpts) prepended by main.js, then optionally the user's
// AI rules appended at the end.

const { appendAiRules } = require('./profile-context');

function formatTranscript(turns, limit) {
  const recent = limit ? turns.slice(-limit) : turns;
  return recent.map((t) => (t.channel === 'them' ? 'Them: ' : 'You: ') + t.text).join('\n');
}

function buildSystem(base, contextBlock) {
  if (!contextBlock) return base;
  return contextBlock + '\n\n' + base;
}

// Append the user's AI rules to a mode's system prompt.
function applyRules(prompt, aiRules) {
  return appendAiRules(prompt, aiRules);
}

const BASE_RULES =
  'Always respond in clear, natural English. Never switch to Hindi or any other language unless the user explicitly asks for it. ';

// Shared framing for every call mode. "You" is the Miter rep wearing cue;
// "Them" is the prospect or customer on the other side of the call.
const CALL_FRAME =
  'You are cue, a discreet real-time copilot for a Miter sales or customer-success rep on a live call. ' +
  'Miter is payroll, HR, time tracking and workforce management built for construction contractors: certified payroll and prevailing wage, union fringes, job costing, and syncs with ERPs like Sage, Acumatica, NetSuite and QuickBooks. ' +
  '"You" in the transcript is the rep; "Them" is the prospect or customer. ' +
  'Ground every claim in the retrieved knowledge-base excerpts and the call playbook above. Cite the doc name in a short parenthetical when you rely on one. ' +
  'Never invent pricing, customer names, dates, integrations or capabilities that are not in the excerpts — if the material does not cover it, say so and suggest how to confirm. ' +
  BASE_RULES;

const MOMENT_RULES =
  'Handle the moment by type:\n' +
  '• DISCOVERY (they describe their setup): confirm what you heard in one line, then ask the single most useful next discovery question.\n' +
  '• OBJECTION (a concern or hesitation): acknowledge in one sentence, answer with a specific fact or customer proof point, offer a next step.\n' +
  '• PRICING: value first, then point to the investment summary / proposal as the source of numbers. Never quote a figure that is not in the excerpts.\n' +
  '• COMPETITOR: no bashing. Ask what made them start looking and what matters most; state one concrete Miter strength for construction payroll where it fits.\n' +
  '• REFERENCE: match on public work, union, multi-state, ERP and payroll; offer to arrange a call rather than naming a customer on the spot.\n' +
  '• IMPLEMENTATION: describe the kickoff process and timeline concretely (Launch Manager, kickoff call, survey, Rocketlane, data collection).\n' +
  '• PRODUCT: answer from the Miter Guides excerpts — feature, where it lives, any setup step.\n';

const MODES = {

  // ── Assist: one-shot "do the smart thing" ─────────────────────────────────
  assist: {
    needsScreen: true,
    userBubble: null,
    small: false,
    resumeMode: 'assist',
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        CALL_FRAME +
        'Look at the screenshot and the recent conversation, decide what the rep needs RIGHT NOW, and deliver it directly with no preamble.\n\n' +
        MOMENT_RULES + '\n' +
        'Write in first person as the rep speaking, 2–5 sentences, ready to say out loud. No preamble, no "Here\'s what you could say". Just the words.',
        contextBlock
      ), aiRules);
    },
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 14);
      return 'Recent conversation:\n' + (t || '(none)') + '\n\nRespond with exactly what I should say right now.';
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
        CALL_FRAME +
        'Draft ONE natural, confident reply the rep can say out loud, in first person.\n\n' +
        MOMENT_RULES + '\n' +
        'No quotes, no preamble. Write the actual words to say. 2–5 sentences. End with a question or a clear next step when it fits.',
        contextBlock
      ), aiRules);
    },
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 16);
      return 'Call so far:\n' + (t || '(listening not started yet)') +
        '\n\nWhat should I say next?';
    }
  },

  // ── Recap ──────────────────────────────────────────────────────────────────
  recap: {
    needsScreen: false,
    userBubble: 'Recap',
    small: true,
    resumeMode: 'recap',
    buildSystem(contextBlock, aiRules) {
      return applyRules(buildSystem(
        CALL_FRAME +
        'Summarize the call so far for the rep\'s notes:\n' +
        '• Their setup (headcount, payroll, time tracking, ERP, unions / prevailing wage)\n' +
        '• Pain points and what they want\n' +
        '• Objections or risks raised\n' +
        '• Competitors or alternatives mentioned\n' +
        '• Commitments and next steps (who, what, when)\n' +
        '• Open discovery questions still to ask\n' +
        'Use short bullets under bold headers. Be concise. Skip any header with nothing to report.',
        contextBlock
      ), aiRules);
    },
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 0);
      return 'Full call transcript:\n' + (t || '(nothing captured yet)') + '\n\nRecap this call.';
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
        CALL_FRAME +
        'The rep typed a question. Answer it directly and concisely for the rep (not as words to say aloud unless asked). ' +
        'When it is about Miter\'s product or process, answer from the excerpts and name the source. ' +
        'When it is about the prospect, use the conversation. No preamble.',
        contextBlock
      ), aiRules);
    },
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 12);
      return (t ? 'Recent conversation:\n' + t + '\n\n' : '') + 'Question: ' + ctx.userText;
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
        CALL_FRAME +
        'The prospect asked ONE specific question, provided below. Focus ONLY on answering that question — ignore any other conversation context.\n\n' +
        MOMENT_RULES + '\n' +
        'Write in first person, as the rep speaking. No preamble. 2–5 sentences.',
        contextBlock
      ), aiRules);
    },
    build(ctx) {
      // Only pass the specific question — not the full transcript history
      return 'Answer this specific question from the prospect:\n\n"' + (ctx.userText || '(no question provided)') + '"\n\nGive the full answer I should say out loud.';
    }
  }
};

module.exports = { MODES, formatTranscript };
