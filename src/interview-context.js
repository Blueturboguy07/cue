// interview-context.js
// Builds context-aware, category-specific system prompt blocks for every
// direction an interview can take. Reads the live transcript to detect which
// category is in play and injects only the fields that are relevant.

// ── Question category detection ───────────────────────────────────────────────
const CATEGORY_PATTERNS = {
  behavioral: [
    /tell me about a time/i, /give me an example/i, /describe a situation/i,
    /when you (had|have|faced|dealt|worked|led|managed|failed|struggled)/i,
    /biggest (challenge|achievement|failure|mistake|success)/i,
    /how did you handle/i, /walk me through a time/i, /have you ever/i,
    /conflict with/i, /difficult (coworker|colleague|manager|teammate)/i,
    /under pressure/i, /tight deadline/i, /disagree(d)? with/i,
    /took initiative/i, /learned (quickly|fast|new)/i, /gave feedback/i,
    /leadership (without|experience)/i, /proud of/i,
    /most (challenging|difficult|proud|rewarding)/i,
    /example of (when|a time|how)/i,
    /situation (where|when|in which)/i,
  ],
  motivation: [
    /why (do you want|are you interested|this company|this role|us|here)/i,
    /why (are you leaving|did you leave|move on)/i,
    /what (attracted|draws|interests|excites|appeals) (you|to)/i,
    /where do you see yourself/i, /5 years/i, /career goals/i,
    /ideal (role|company|environment|manager|team)/i,
    /what (kind of|type of) (work|manager|team)/i,
    /motivates you/i, /passionate about/i,
    /why (are you|looking for) (a new|new|this)/i,
    /why should we hire/i,
    /what (do you|would you) bring/i,
    /long.term (goal|plan|career)/i,
    /looking for (in|from) (your next|a new|this)/i,
    /new opportunity/i,
  ],
  situational: [
    /what would you do if/i, /how would you (handle|approach|deal with)/i,
    /imagine you/i, /hypothetically/i, /if you (joined|started|were)/i,
    /how would you prioritize/i, /production (outage|incident|down)/i,
    /codebase (is a mess|legacy|technical debt)/i,
    /disagree with (your manager|a decision)/i,
    /walked into/i, /first (30|60|90) days/i,
  ],
  experience: [
    /tell me about your (experience|background|role|work|time) (at|in|with|on)/i,
    /walk me through your (resume|background|experience|role|career|most recent)/i,
    /walk me through (your|the) (role|position|work|project)/i,
    /what (were you responsible|did you do|was your role)/i,
    /biggest (project|achievement) (at|there|in your)/i,
    /tech stack/i, /day.to.day/i, /what did you build/i,
    /tell me more about/i, /elaborate on/i,
    /tell me about yourself/i,
    /tell me about your (current|previous|last|recent) (role|job|position|company)/i,
    /tell me about your time at/i,
    /what have you been working on/i,
    /walk me through what you('ve)? (done|built|worked on)/i,
    /can you (elaborate|expand) on/i,
    /your (most recent|last|current|previous) (role|job|position)/i,
  ],
  compensation: [
    /salary (expectation|requirement|range)/i, /compensation/i,
    /how much (are you|do you) (making|expect|want)/i,
    /when can you start/i, /notice period/i, /start date/i,
    /other (offer|interview|option)/i, /interviewing elsewhere/i,
    /do you have (any )?questions/i, /questions for us/i, /questions for me/i,
    /anything (you'?d? like to|you want to) ask/i,
    /we have (a few minutes|some time) (left|for questions)/i,
  ],
  technical: [
    /system design/i, /design (a|an|the) (system|service|api|database|url|feed|chat|cache|queue)/i,
    /explain (how|what|why|the difference|the concept)/i,
    /tradeoff/i, /trade.off/i,
    /sql vs nosql/i, /difference between/i,
    /what is .{2,40}\?/i,
    /how does .{2,40} work/i,
    /how would you design/i,
    /complexity/i, /algorithm/i, /data structure/i,
    /scale (this|to|it|a)/i, /architecture/i,
    /when (would you use|should you use|to use)/i,
    /pros and cons/i, /advantages (of|and disadvantages)/i,
    /implement (a|an|the)/i, /how (is|are|do|does|would)/i,
  ],
};

function detectCategory(transcript) {
  if (!transcript || !transcript.length) return 'general';
  // Look at the last 5 "Them" turns — the interviewer's recent questions
  const recentThem = transcript
    .filter(t => t.channel === 'them')
    .slice(-5)
    .map(t => t.text)
    .join(' ');
  if (!recentThem) return 'general';

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some(re => re.test(recentThem))) return category;
  }
  return 'general';
}

// ── Resume parser (carried over from resume-context.js) ───────────────────────
const SECTION_PATTERNS = [
  { key: 'name',       re: null, label: null },
  { key: 'summary',    re: /(?:summary|objective|profile|about)[^\n]*\n([\s\S]{20,400}?)(?=\n[A-Z]|\n\n[A-Z]|$)/i,      label: 'Summary' },
  { key: 'experience', re: /(?:experience|work history|employment)[^\n]*\n([\s\S]{20,1800}?)(?=\n(?:education|skills|projects|certif|awards|$))/i, label: 'Experience' },
  { key: 'skills',     re: /(?:skills?|technical skills?|competencies|tech stack)[^\n]*\n([\s\S]{10,600}?)(?=\n(?:experience|education|projects|certif|awards|work|$))/i, label: 'Skills' },
  { key: 'education',  re: /(?:education|academic)[^\n]*\n([\s\S]{10,400}?)(?=\n(?:experience|skills|projects|certif|awards|work|$))/i, label: 'Education' },
  { key: 'projects',   re: /(?:projects?|portfolio)[^\n]*\n([\s\S]{10,800}?)(?=\n(?:experience|education|skills|certif|awards|work|$))/i, label: 'Projects' },
];

function parseResume(text) {
  if (!text || !text.trim()) return null;
  const clean = text.trim();
  const sections = {};
  const firstLine = clean.split('\n').find(l => l.trim().length > 1 && l.trim().length < 80);
  if (firstLine) sections.name = firstLine.trim();
  for (const { key, re } of SECTION_PATTERNS) {
    if (!re) continue;
    const m = re.exec(clean);
    if (m && m[1]) sections[key] = m[1].trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  }
  return { sections, raw: clean, parsed: Object.keys(sections).length > 1 };
}

function clip(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd() + '…';
}

// ── Context builders by category ──────────────────────────────────────────────

function buildResumeBlock(resumeText, limit = 2400) {
  if (!resumeText || !resumeText.trim()) return '';
  const parsed = parseResume(resumeText);
  if (!parsed) return '';
  if (parsed.parsed) {
    const parts = [];
    let rem = limit;
    const order = ['name', 'summary', 'experience', 'skills', 'projects', 'education'];
    for (const key of order) {
      if (rem <= 0) break;
      const val = parsed.sections[key];
      if (!val) continue;
      const sp = SECTION_PATTERNS.find(s => s.key === key);
      const label = sp && sp.label;
      const chunk = label ? `${label}:\n${clip(val, Math.min(rem - label.length - 2, 800))}` : clip(val, 80);
      parts.push(chunk);
      rem -= chunk.length;
    }
    return parts.join('\n\n');
  }
  return clip(parsed.raw, limit);
}

function buildJDBlock(jd, limit = 600) {
  if (!jd || !jd.trim()) return '';
  return 'Target Role / Job Description:\n' + clip(jd.trim().replace(/\s+/g, ' '), limit);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * buildInterviewContext(settings, mode, transcript)
 * Returns a system-prompt string with only the context fields relevant to
 * the detected interview category. Returns null for leetcode mode.
 */
function buildInterviewContext(settings, mode, transcript) {
  // Coding problems never need personal context
  if (mode === 'leetcode') return null;

  const category = detectCategory(transcript || []);

  const resume    = settings.resumeText || '';
  const jd        = settings.jobDescription || '';
  const stories   = settings.starStories || '';
  const whyCo     = settings.whyCompany || '';
  const whyLeave  = settings.whyLeaving || '';
  const workStyle = settings.workStyle || '';
  const salary    = settings.salaryTarget || '';
  const questions = settings.questionsToAsk || '';

  const hasResume  = resume.trim().length > 0;
  const hasStories = stories.trim().length > 0;
  const hasJD      = jd.trim().length > 0;

  const blocks = [];

  // Always include resume if available (but size varies by category)
  if (hasResume) {
    const resumeLimit = (category === 'behavioral' || category === 'experience') ? 2400 : 1400;
    const rb = buildResumeBlock(resume, resumeLimit);
    if (rb) blocks.push('=== Your Background ===\n' + rb);
  }

  // Job description — always include when available
  if (hasJD) {
    blocks.push(buildJDBlock(jd, category === 'technical' ? 300 : 600));
  }

  // Category-specific injections
  switch (category) {

    case 'behavioral':
      if (hasStories) {
        blocks.push(
          '=== Your STAR Stories (use these for behavioral questions) ===\n' +
          clip(stories.trim(), 2000) + '\n' +
          'IMPORTANT: When answering behavioral questions, use these real stories. ' +
          'Structure your answer: Situation → Task → Action → Result. ' +
          'Be specific, use numbers/metrics when available, keep it under 2 minutes spoken.'
        );
      } else {
        blocks.push(
          '(No STAR stories provided — construct a plausible story from the candidate\'s experience above. ' +
          'Be specific and grounded, avoid generic statements.)'
        );
      }
      if (workStyle) blocks.push('Work Style / Values:\n' + clip(workStyle, 400));
      break;

    case 'motivation':
      if (whyCo)    blocks.push('Why This Company:\n' + clip(whyCo, 500));
      if (whyLeave) blocks.push('Why Leaving Current Role:\n' + clip(whyLeave, 300));
      if (workStyle) blocks.push('Ideal Work Environment / Values:\n' + clip(workStyle, 400));
      break;

    case 'situational':
      if (workStyle) blocks.push('Decision-Making Style / Values:\n' + clip(workStyle, 500));
      if (hasStories) blocks.push('Relevant Past Experience:\n' + clip(stories, 800));
      break;

    case 'experience':
      // Already have full resume — no extra blocks needed
      if (hasStories) blocks.push('Key Stories / Highlights:\n' + clip(stories, 1000));
      break;

    case 'compensation':
      if (salary)    blocks.push('Salary Target:\n' + salary);
      if (questions) blocks.push('Questions to Ask Interviewer:\n' + clip(questions, 600));
      break;

    case 'technical':
      // Resume skills section is most relevant here — already included above
      break;

    case 'general':
    default:
      if (hasStories) blocks.push('Key Experience Highlights:\n' + clip(stories, 600));
      if (workStyle)  blocks.push('Work Style:\n' + clip(workStyle, 300));
      break;
  }

  if (!blocks.length) return null;

  const tailorNote = hasJD
    ? '\nTailor every answer to highlight fit with the target role above.'
    : '';

  return blocks.join('\n\n') + tailorNote;
}

// ── Legacy compat ─────────────────────────────────────────────────────────────
function buildResumeContext(resumeText, jobDescription, mode) {
  if (!resumeText || !String(resumeText).trim()) return null;
  if (typeof jobDescription === 'number') {
    const cleaned = String(resumeText).trim().replace(/\s+/g, ' ');
    const limit = jobDescription || 1200;
    const clipped = cleaned.length > limit ? cleaned.slice(0, limit).trimEnd() + '…' : cleaned;
    return ['Candidate resume context:', clipped, 'Use this resume information when answering questions about the candidate.'].join('\n');
  }
  // Lightweight: no transcript available, just wrap resume+JD
  const rb = buildResumeBlock(resumeText, 1800);
  const jb = buildJDBlock(jobDescription || '', 600);
  const parts = [];
  if (rb) parts.push('=== Your Background ===\n' + rb);
  if (jb) parts.push(jb);
  if (!parts.length) return null;
  return parts.join('\n\n');
}

// ── Work Mode context builder ─────────────────────────────────────────────────

/**
 * buildWorkContext(settings, mode, transcript)
 * Returns a system-prompt context block for Work Mode features.
 * Injects work role, project notes, and meeting context.
 */
function buildWorkContext(settings, _mode, _transcript) {
  const wc = settings.workContext || '';
  const pn = settings.projectNotes || '';
  const mn = settings.meetingNotesContext || '';
  const tr = settings.teamRoster || '';
  const man = settings.managerNotes || '';
  const ks = settings.keyStakeholders || '';

  const blocks = [];

  const persona = settings.workPersona || 'participant';
  if (persona === 'leader') {
    blocks.push('=== Your Persona ===\nYou are acting as a Meeting Leader. Proactively suggest questions to ask, identify when topics are dragging, and recommend action items to assign to participants.');
  } else {
    blocks.push('=== Your Persona ===\nYou are acting as a Meeting Participant. Focus on answering direct questions, summarizing key points silently, and noting down action items assigned to you.');
  }

  if (wc.trim()) {
    blocks.push('=== Your Role & Team ===\n' + clip(wc.trim(), 800));
  }
  if (tr.trim()) {
    blocks.push('=== Team Roster ===\n' + clip(tr.trim(), 800));
  }
  if (man.trim()) {
    blocks.push('=== Manager Notes ===\n' + clip(man.trim(), 600));
  }
  if (ks.trim()) {
    blocks.push('=== Key Stakeholders ===\n' + clip(ks.trim(), 600));
  }
  if (pn.trim()) {
    blocks.push('=== Project Notes ===\n' + clip(pn.trim(), 30000));
  }
  if (mn.trim()) {
    blocks.push('=== Meeting Context ===\n' + clip(mn.trim(), 600));
  }

  if (!blocks.length) return null;
  return blocks.join('\n\n');
}

module.exports = { buildInterviewContext, buildWorkContext, buildResumeContext, detectCategory, parseResume };
