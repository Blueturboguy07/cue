// Drops microphone lines the transcriber invented from room noise.
//
// Speech models fill near-silence with fluent text from their training data.
// In a quiet room cue's mic channel came back with "Chị nhìn là vô liền."
// and "Olá! Sou a professora Danielle Ribeiro e a gente vai conversar hoje…"
// (a video intro), and the meeting notes then said the candidate had
// introduced themself in Portuguese. The other side's loopback audio is
// digital silence when nobody talks, so this only filters the mic.
//
// Two tests, both cheap:
//   - stock phrases these models produce from silence ("Thanks for
//     watching", "Subtitles by…");
//   - a line of 4+ words that is not English: it carries letters outside
//     plain English and almost none of the most common English words.
//     cue answers in English, and an English speaker's line, even a
//     clipped one, is full of "I", "the", "and", "to", "you"…

const COMMON_ENGLISH = new Set((
  'a an the and or but so if then than that this these those it its is are was were be been being am ' +
  'i me my we us our you your he him his she her they them their what which who whom whose when where why how ' +
  'to of in on at by for with about from into over after before up down out off as not no yes yeah okay ok ' +
  'do does did done have has had will would can could should may might must just also very really ' +
  'there here all any some more most one two like know think mean well right sure thanks thank please'
).split(/\s+/));

const STOCK_PHRASES = [
  /\bthanks? (?:you )?for watching\b/i,
  /\bplease (?:like and )?subscribe\b/i,
  /\bsubtitles? (?:by|created by|provided by)\b/i,
  /\bamara\.org\b/i,
  /\btranscribed by\b/i,
  /^\W*(?:music|applause|silence|no speech|inaudible)\W*$/i
];

function words(text) {
  return String(text || '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

function looksNonEnglish(text) {
  const w = words(text);
  if (w.length < 4) return false; // too short to judge ("Oui." or a name)
  const foreignLetters = /[^\x00-\x7F’‘“”–—…]/.test(text);
  if (!foreignLetters) return false;
  const common = w.filter((x) => COMMON_ENGLISH.has(x)).length;
  return common / w.length < 0.25; // English lines run 0.4-0.6; Portuguese that shares "a" and "do" ~0.16
}

// True when a microphone line is most likely invented, not said.
function isLikelyInventedMicLine(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (STOCK_PHRASES.some((re) => re.test(t))) return true;
  return looksNonEnglish(t);
}

module.exports = { isLikelyInventedMicLine, looksNonEnglish };
