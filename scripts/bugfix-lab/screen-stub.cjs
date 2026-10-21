// bugfix-lab helper (cue-20261019-c0d7c6): preloaded with `electron -r` so main.js sees a fake multi-display
// layout. Only electron's `screen` is replaced; everything else is the real module. Layout comes from LAB_LAYOUT
// (JSON array of {x,y,width,height,scaleFactor,primary,taskbar}); the cursor from the JSON file named by LAB_CURSOR.
const Module = require('module');
const fs = require('fs');
const layout = JSON.parse(process.env.LAB_LAYOUT || '[]');
const displays = layout.map((d, i) => ({
  id: i + 1,
  scaleFactor: d.scaleFactor || 1,
  bounds: { x: d.x, y: d.y, width: d.width, height: d.height },
  workArea: { x: d.x, y: d.y, width: d.width, height: d.height - (d.taskbar || 0) },
  size: { width: d.width, height: d.height },
  workAreaSize: { width: d.width, height: d.height - (d.taskbar || 0) },
  primary: !!d.primary
}));
const area = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const dist = (d, p) => { const b = d.bounds; const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width)), dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height)); return dx * dx + dy * dy; };
let announced = false;
const fake = {
  getPrimaryDisplay() { if (!announced) { announced = true; process.stderr.write('STUB_ACTIVE ' + JSON.stringify(displays.map((d) => d.workArea)) + '\n'); } return displays.find((d) => d.primary) || displays[0]; },
  getAllDisplays() { return displays; },
  getDisplayMatching(r) { return displays.slice().sort((a, b) => area(b.bounds, r) - area(a.bounds, r))[0]; },
  getDisplayNearestPoint(p) { return displays.slice().sort((a, b) => dist(a, p) - dist(b, p))[0]; },
  getCursorScreenPoint() { try { return JSON.parse(fs.readFileSync(process.env.LAB_CURSOR, 'utf8')); } catch (_) { return { x: 0, y: 0 }; } },
  on() { return fake; }, once() { return fake; }, removeListener() { return fake; }, off() { return fake; }
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  const m = load.apply(this, arguments);
  if (request === 'electron' && m && typeof m === 'object' && !m.__labStub) {
    return new Proxy(m, { get: (t, p) => (p === '__labStub' ? true : p === 'screen' ? fake : t[p]) });
  }
  return m;
};
