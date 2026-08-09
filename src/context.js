// Context engine — builds prompt-ready context from raw state.
// Separates raw capture (audio buffers, screen URL) from normalized context
// (rolling transcript window, profile, memory) from LLM prompt construction.

const { MODES } = require('./prompts');

// Build the normalized context object. Pure, so it is unit-testable.
// state = { transcript: [{channel, text, ts}], userText, settings, memory }
function buildContext(state) {
  const { transcript = [], userText = '', settings = {} } = state;
  const rt = getRecent(transcript, 12);
  return {
    transcript,
    recent: rt,
    userText,
    profile: settings.context || '',
    smart: !!settings.smart,
    memory: state.memory || []
  };
}

// Rolling transcript window: newest N turns, oldest first.
function getRecent(turns, n) {
  return turns.slice(-n);
}

// Compose the system prompt for a mode, weaving in profile/memory.
function buildSystem(def, ctx) {
  let system = typeof def.buildSystem === 'function' ? def.buildSystem('') : (def.system || '');
  if (ctx.profile && ['assist', 'say', 'ask'].includes(def.key)) {
    system = 'Here is my background and experience. Weave it into my answer naturally. Name the projects, the tech, the results. This keeps my answer real instead of generic.\n\n---\n' + ctx.profile + '\n---\n\n' + system;
  }
  return system;
}

// Build the user turn for a mode. Reuses MODES[].build but passes normalized context.
function buildUserTurn(def, ctx) {
  return def.build({ transcript: ctx.recent, userText: ctx.userText, memory: ctx.memory });
}

// How much of the conversation to include per mode (turns).
const MODE_WINDOW = { assist: 12, say: 14, followup: 20, recap: 0, ask: 12, leetcode: 0 };

function windowFor(mode) {
  const n = MODE_WINDOW[mode];
  return n == null ? 12 : n;
}

module.exports = { buildContext, getRecent, buildSystem, buildUserTurn, windowFor };