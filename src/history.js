// Persistent, reviewable history — written only once there is something to
// keep (never an empty file just because the app opened), one folder per day:
//
//   ~/.config/cue/history/2026-08-18/
//     chat.json          questions, answers, meeting transcript — appended live
//     shot-143205-1.png  screenshots you attached, saved as real PNGs
//
// Plain files on purpose: open the folder, read the JSON, view the PNGs. No
// sessions, no database, no loading UI. Clear History wipes today's folder.
const fs = require('fs');
const path = require('path');

let baseDir = null;

function init(userDataDir) {
  baseDir = path.join(userDataDir, 'history');
}

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeKey(d = new Date()) { return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

function dayDir(create) {
  if (!baseDir) return null;
  const dir = path.join(baseDir, dayKey());
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readDay(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8')); }
  catch (_) { return { date: dayKey(), entries: [] }; }
}

function writeDay(dir, data) {
  const tmp = path.join(dir, 'chat.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, 'chat.json')); // atomic swap, never a torn file
}

// Save attached screenshots as PNGs; returns their relative file names.
function saveImages(dir, images) {
  const names = [];
  (images || []).forEach((dataUrl, i) => {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) return;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `shot-${timeKey()}-${i + 1}.${ext}`;
    try { fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64')); names.push(name); }
    catch (_) { /* best effort */ }
  });
  return names;
}

// Append one entry. `entry` = { kind:'qa', mode, question, answer, images:[dataUrl] }
// or { kind:'transcript', channel, text }. Creates the day folder on first use.
function append(entry) {
  if (!baseDir) return null;
  try {
    const dir = dayDir(true);
    const data = readDay(dir);
    const record = { ts: new Date().toISOString(), ...entry };
    if (entry.images && entry.images.length) {
      record.images = saveImages(dir, entry.images); // replace data URLs with file names
    }
    data.entries.push(record);
    writeDay(dir, data);
    return dir;
  } catch (_) { return null; }
}

// Wipe today's folder (Clear History). Older days are left alone.
function clearToday() {
  if (!baseDir) return false;
  try {
    const dir = dayDir(false);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function historyDir() { return baseDir; }

module.exports = { init, append, clearToday, historyDir, dayKey, timeKey };
