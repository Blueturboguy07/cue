// call-context.js — sales / customer-call awareness for cue.
//
// Replaces the interview category detector. Reads the last few "Them" turns
// (the prospect or customer) and classifies what kind of moment the rep is in,
// then produces two things main.js uses:
//   1. a short playbook block for the system prompt (how to handle this moment)
//   2. retrieval hints — extra terms appended to the knowledge-base query so
//      the matching Slite playbook (discovery questions, kickoff process,
//      customer references, competitor discovery, assets) ranks first.
//
// Pure functions, no Electron.

const CATEGORY_PATTERNS = {
  pricing: [
    /\b(price|pricing|cost|costs|how much|per employee|per user|pepm|per month|annual|contract|quote|proposal|discount|budget|implementation fee|invoice|fees?)\b/i,
    /\bwhat (does|would) (it|this|miter) (cost|run)\b/i,
  ],
  competitor: [
    // Payroll / HCM vendors a construction buyer would weigh against Miter. ERPs and
    // field tools (Sage, Acumatica, Procore, HCSS…) are integration partners, not
    // competitors — they belong to discovery below.
    /\b(adp|paychex|gusto|rippling|paycom|paylocity|workday|bamboo ?hr|justworks|trinet|foundation software|arcoro|points north|lcptracker|ebacon|quickbooks payroll|intuit payroll)\b/i,
    /\b(compared to|versus|vs\.?|other (vendors|options|solutions|tools)|also (looking at|evaluating|talking to)|competitor|front.?runner|shortlist|why (you|miter) (over|instead))\b/i,
  ],
  objection: [
    /\b(concern|worried|worry|hesitant|hesitation|risk|risky|not sure|too (expensive|small|new|early)|deal.?breaker|blocker|push.?back|skeptical|doubt)\b/i,
    /\bwhat if (it|you|miter|something) (doesn'?t|don'?t|fails?|breaks?|goes wrong)\b/i,
    /\b(we'?ve been burned|last (vendor|time|switch)|switching (is|was) (painful|hard))\b/i,
    /\bwhy (should|would) we\b/i,
  ],
  implementation: [
    /\b(implement|implementation|onboard|onboarding|kick.?off|go.?live|launch|timeline|how long (does|will) (it|this|setup) take|migrate|migration|data (import|transfer|load)|parallel (run|payroll)|cut.?over|rocketlane|training)\b/i,
    /\bwho (do we|will we) work with (after|once)\b/i,
  ],
  reference: [
    /\b(reference|references|talk to (a|an|another|one of your) (customer|client)|case stud(y|ies)|who else (uses|is using)|similar (companies|contractors|customers)|customers like us)\b/i,
  ],
  discovery: [
    /\b(we (currently|today) (use|run|do|have)|right now we|our (current|existing) (system|process|setup|payroll|erp|software)|we'?re on|we (process|run) payroll)\b/i,
    /\b(tell (you|us) (a little )?about (our|us|the company)|we have (about|around|roughly)? ?\d+ (employees|people|guys|field|crew))\b/i,
    /\b(prevailing wage|certified payroll|union|unions|fringe|fringes|davis.?bacon|multi.?state|job cost|cost codes?)\b/i,
    /\b(sage|intacct|acumatica|quickbooks|netsuite|procore|hcss|heavy ?job|viewpoint|vista|foundation|raken|busybusy|exaktime|erp)\b/i,
  ],
  product: [
    /\b(can (it|miter|you) (do|handle|support|integrate|sync|track|export)|does (it|miter) (do|have|handle|support|integrate|sync|track|export)|is there (a|an|any) (way|feature|report|integration)|how (does|do) (it|miter|you) (handle|do|work|sync|track))\b/i,
    /\b(feature|integration|integrate|report|reporting|mobile app|time ?clock|geofenc|gps|expense|per diem|benefits|401k|pto|scheduling|dashboard|api)\b/i,
  ],
};

// Checked in this order — the first category whose pattern matches wins, so
// the more decisive moments (money, a named competitor, a worry) beat the
// broad ones (a feature question) when a turn contains both.
const PRIORITY = ['pricing', 'competitor', 'objection', 'reference', 'implementation', 'discovery', 'product'];

function detectCallCategory(transcript) {
  if (!transcript || !transcript.length) return 'general';
  const recentThem = transcript
    .filter((t) => t.channel === 'them')
    .slice(-5)
    .map((t) => t.text)
    .join(' ');
  if (!recentThem) return 'general';
  for (const category of PRIORITY) {
    if (CATEGORY_PATTERNS[category].some((re) => re.test(recentThem))) return category;
  }
  return 'general';
}

// Per-category playbook guidance (for the system prompt) and retrieval hints
// (appended to the knowledge-base query). Hints are phrased to match the
// titles of the Slite docs in knowledge-base/slite/.
const PLAYBOOK = {
  discovery: {
    label: 'Discovery',
    guidance:
      'The prospect is describing their current setup. Listen for the must-haves: headcount, current payroll provider, time-tracking method, ERP/accounting system, timeline to purchase. ' +
      'Ask one sharp follow-up at a time from the discovery question set — prevailing wage / certified payroll, union fringes, ERP dimensions and sync expectations, benefits and 401k, and launch-blocking items (courtesy taxes, local taxes, activity-based workers comp, paper checks, integration scoping).',
    hints: 'discovery questions must-haves payroll WFM HR benefits dimensions syncs launch-related questions',
  },
  objection: {
    label: 'Objection',
    guidance:
      'The prospect raised a concern. Acknowledge it plainly in one sentence, then answer with a specific fact — how Miter actually handles it, a customer who had the same worry, or a step in the implementation process that de-risks it. ' +
      'Never argue and never over-promise. If the honest answer is a workaround or a limitation, say so and frame the path forward.',
    hints: 'customer references reference program discovery questions launch-related questions to confirm',
  },
  pricing: {
    label: 'Pricing',
    guidance:
      'Pricing came up. Anchor on value and what is included before numbers. Point to the investment summary, proposal template and order form as the artifacts that carry the actual figures, and note the implementation fee is invoiced separately via Stripe. ' +
      'Do not invent prices, discounts or terms that are not in the retrieved material.',
    hints: 'assets investment summary proposal template order form service level agreement implementation fee',
  },
  competitor: {
    label: 'Competitor',
    guidance:
      'A competitor or alternative is in play. Do not bash them and do not start a feature war. Use the competitor-discovery approach: ask what made them start looking, what matters most in a solution, what has stood out in each option, and what their process is for narrowing down. ' +
      'Where Miter is genuinely stronger for a construction payroll + workforce buyer (certified payroll, union fringes, job costing, ERP sync), say it once, concretely.',
    hints: 'competitor discovery questions to ask find the gap understand their criteria',
  },
  reference: {
    label: 'Reference',
    guidance:
      'They want to hear from a customer. Follow the reference process: match on public/prevailing-wage work, union, multi-state, ERP and payroll system; check the reference activity report so no one is over-used; confirm in #gtm with the Launch Manager before naming anyone. ' +
      'Offer to set up the call rather than promising a specific company on the spot.',
    hints: 'customer references reference customer report reference activity report enrolling a customer reference',
  },
  implementation: {
    label: 'Implementation',
    guidance:
      'The conversation is about getting live. Describe the kickoff process concretely: Launch assigns a Launch Manager and Launch Ops within two business days of close; a 45-minute kickoff is scheduled roughly 10 weeks before launch for under 100 employees and 12–14 weeks for larger teams; the kickoff survey and employee directory come first; Rocketlane tracks the project. ' +
      'Set expectations about data collection, parallel payroll and what the customer owns.',
    hints: 'kickoff process series of events launch manager rocketlane kickoff deck kickoff survey',
  },
  product: {
    label: 'Product',
    guidance:
      'A capability or how-does-it-work question. Answer from the Miter Guides excerpts when they cover it — name the feature, where it lives in the dashboard, and any setup step. If the guides do not cover it, say what you know and offer to confirm rather than guessing.',
    hints: '',
  },
  general: {
    label: 'General',
    guidance:
      'Keep the conversation moving. Prefer a clarifying question or a concrete next step over a monologue.',
    hints: '',
  },
};

function playbookFor(category) {
  return PLAYBOOK[category] || PLAYBOOK.general;
}

// The block main.js prepends to the system prompt.
function buildCallContext(settings, mode, transcript) {
  const category = detectCallCategory(transcript || []);
  const pb = playbookFor(category);
  const lines = [
    '=== Call playbook: ' + pb.label + ' ===',
    pb.guidance,
  ];
  const notes = typeof settings.callNotes === 'string' ? settings.callNotes.trim() : '';
  if (notes) lines.push('', '=== Notes for this call ===', notes.slice(0, 2000));
  return lines.join('\n');
}

// Extra terms appended to the knowledge-base query for a category.
function retrievalHints(category) {
  return playbookFor(category).hints || '';
}

module.exports = { detectCallCategory, buildCallContext, retrievalHints, CATEGORY_PATTERNS, PLAYBOOK };
