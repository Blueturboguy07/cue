const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createMeetingStore } = require('../src/meetings');
const { createMeetingMemory } = require('../src/meeting-memory');

const NOTES = 'Meeting Summary:\nAgreed to ship the Terraform pipeline Tuesday. Budget is $40k.\n\nKey Points:\n- Pipeline is green\n\nDecisions:\n- Ship Tuesday\n\nAction Items:\n- You: send the runbook\n\nFollow-Up:\n- Confirm budget with finance\n';

function harness({ llmReady = true, llmText = NOTES, t0 = 1_000_000, destination = 'test-provider', stream } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-memory-'));
  const store = createMeetingStore({ file: path.join(dir, 'meetings.json') });
  let clock = t0;
  const llmCalls = [];
  let allowedDestination = destination;
  const llmFactory = () => ({
    ready: llmReady,
    async stream(params) { llmCalls.push(params); return stream ? stream(params) : llmText; }
  });
  const logs = [];
  const memory = createMeetingMemory({ store, llmFactory, now: () => clock, log: (m) => logs.push(m), minTurnsForNotes: 2, getNotesDestination: () => allowedDestination });
  return { store, memory, llmCalls, logs, setDestination: (value) => { allowedDestination = value; }, tick: (ms) => { clock += ms; }, file: store.file };
}
const turn = (channel, text, ts) => ({ channel, text, ts });

test('the first turn opens a meeting and every turn is persisted', () => {
  const { store, memory, file } = harness();
  assert.equal(memory.current, null);
  memory.onTurn(turn('them', 'hello', 1_000_001));
  memory.onTurn(turn('you', 'hi', 1_000_002));
  assert.ok(memory.current);
  const onDisk = createMeetingStore({ file }).all();
  assert.equal(onDisk.length, 1);
  assert.deepEqual(onDisk[0].transcript.map((t) => t.text), ['hello', 'hi']);
  assert.equal(onDisk[0].endedAt, null);
  assert.equal(store.all()[0].id, memory.current.id);
});

test('refreshNotes writes LLM notes and a title once, then only again when there are new turns', async () => {
  const { store, memory, llmCalls, tick } = harness();
  memory.onTurn(turn('them', 'We should ship the Terraform pipeline Tuesday.', 1_000_001));
  memory.onTurn(turn('you', 'Budget is forty thousand.', 1_000_002));
  tick(10);
  const notes = await memory.refreshNotes();
  assert.equal(llmCalls.length, 1);
  assert.match(llmCalls[0].turns[0].text, /Them: We should ship the Terraform pipeline Tuesday\./);
  assert.equal(notes.summary, 'Agreed to ship the Terraform pipeline Tuesday. Budget is $40k.');
  const m = store.get(memory.current.id);
  assert.equal(m.title, 'Agreed to ship the Terraform pipeline Tuesday.');
  assert.deepEqual(m.actionItems, ['You: send the runbook']);
  assert.deepEqual(m.decisions, ['Ship Tuesday']);

  assert.equal(await memory.refreshNotes(), null, 'nothing new — no second LLM call');
  assert.equal(llmCalls.length, 1);
  memory.onTurn(turn('them', 'One more thing.', 1_000_003));
  await memory.refreshNotes();
  assert.equal(llmCalls.length, 2);
});

test('a meeting shorter than minTurnsForNotes gets no notes', async () => {
  const { memory, llmCalls } = harness();
  memory.onTurn(turn('them', 'hello', 1_000_001));
  assert.equal(await memory.refreshNotes(), null);
  assert.equal(llmCalls.length, 0);
});

test('no usable LLM: turns are still persisted, notes are skipped without throwing', async () => {
  const { memory, store, llmCalls } = harness({ llmReady: false });
  memory.onTurn(turn('them', 'a', 1_000_001));
  memory.onTurn(turn('you', 'b', 1_000_002));
  assert.equal(await memory.end(), null);
  assert.equal(llmCalls.length, 0);
  assert.equal(store.all()[0].transcript.length, 2);
  assert.ok(store.all()[0].endedAt);
});

test('end() closes the meeting; the next turn starts a new one', async () => {
  const { memory, store } = harness();
  memory.onTurn(turn('them', 'a', 1_000_001));
  memory.onTurn(turn('you', 'b', 1_000_002));
  await memory.end();
  assert.equal(memory.current, null);
  memory.onTurn(turn('them', 'c', 1_000_003));
  assert.equal(store.all().length, 2);
  assert.ok(store.all()[0].endedAt);
  assert.equal(store.all()[1].endedAt, null);
});

test('a long silence between turns ends the meeting implicitly', () => {
  const { memory, store, tick } = harness();
  memory.onTurn(turn('them', 'a', 1_000_001));
  tick(31 * 60 * 1000);
  memory.onTurn(turn('them', 'b', 1_000_001 + 31 * 60 * 1000));
  assert.equal(store.all().length, 2, 'second turn belongs to a new meeting');
});

test('resumeOpen picks up a recent interrupted meeting and restores its turns', () => {
  const { store, file, tick } = harness();
  const m = store.add();
  store.addTurn(m.id, turn('them', 'before the crash', 1_000_050));
  store.addTurn(m.id, turn('you', 'yes', 1_000_060));
  // fresh process, 5 minutes later
  const later = createMeetingMemory({ store: createMeetingStore({ file }), llmFactory: () => null, now: () => 1_000_060 + 5 * 60 * 1000 });
  const restored = later.resumeOpen();
  assert.deepEqual(restored.map((t) => t.text), ['before the crash', 'yes']);
  assert.equal(later.current.id, m.id);
  later.onTurn(turn('them', 'continuing', 1_000_060 + 5 * 60 * 1000 + 1));
  assert.equal(createMeetingStore({ file }).get(m.id).transcript.length, 3);
  void tick;
});

test('resumeOpen closes a stale open meeting instead of resuming it', () => {
  const { store, file } = harness();
  const m = store.add();
  store.addTurn(m.id, turn('them', 'yesterday', 1_000_050));
  const later = createMeetingMemory({ store: createMeetingStore({ file }), llmFactory: () => null, now: () => 1_000_050 + 2 * 60 * 60 * 1000 });
  assert.deepEqual(later.resumeOpen(), []);
  assert.equal(later.current, null);
  assert.equal(createMeetingStore({ file }).get(m.id).endedAt, 1_000_050, 'closed at its last turn');
});

test('catchUp writes notes for ended meetings that have none', async () => {
  const { store, memory, llmCalls } = harness();
  const a = store.add(); store.addTurn(a.id, turn('them', 'a', 1)); store.addTurn(a.id, turn('you', 'b', 2)); store.update(a.id, { endedAt: 3, notesDestination: 'test-provider' });
  const b = store.add(); store.addTurn(b.id, turn('them', 'short', 4)); store.update(b.id, { endedAt: 5 }); // too short
  const c = store.add(); store.addTurn(c.id, turn('them', 'x', 6)); store.addTurn(c.id, turn('you', 'y', 7)); store.update(c.id, { endedAt: 8, summary: 'already done' });
  assert.equal(await memory.catchUp(), 1);
  assert.equal(llmCalls.length, 1);
  assert.ok(store.get(a.id).summary);
  assert.equal(store.get(b.id).summary, '');
});

test('store: prune keeps the newest N and debounced saves coalesce until flush', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-memory-'));
  const file = path.join(dir, 'meetings.json');
  const s = createMeetingStore({ file, debounceMs: 50 });
  for (let i = 0; i < 4; i++) s.add();
  assert.equal(s.prune(2), 2);
  assert.equal(s.all().length, 2);
  assert.ok(!fs.existsSync(file), 'nothing on disk yet — writes are coalesced');
  s.flush();
  assert.equal(createMeetingStore({ file }).all().length, 2);
});

function addConversation(memory) {
  memory.onTurn(turn('them', 'synthetic question', 1_000_001));
  memory.onTurn(turn('you', 'synthetic response', 1_000_002));
}

test('notes opt-out suppresses stop, clear/end, and startup catch-up requests', async () => {
  const { memory, store, llmCalls } = harness({ destination: null });
  addConversation(memory);
  assert.equal(await memory.refreshNotes(), null);
  assert.equal(await memory.end(), null);
  assert.equal(await memory.catchUp(), 0);
  assert.equal(llmCalls.length, 0);
  assert.equal(store.all()[0].transcript.length, 2);
});

test('old meetings without a destination approval are never sent during catch-up', async () => {
  const { memory, store, llmCalls } = harness();
  const old = store.add();
  store.addTurn(old.id, turn('them', 'old words', 1));
  store.addTurn(old.id, turn('you', 'old reply', 2));
  store.update(old.id, { endedAt: 3 });
  assert.equal(await memory.catchUp(), 0);
  assert.equal(llmCalls.length, 0);
});

test('changing providers cannot authorize an existing meeting', async () => {
  const { memory, llmCalls, setDestination } = harness();
  addConversation(memory);
  setDestination('another-provider');
  assert.equal(await memory.refreshNotes(), null);
  assert.equal(await memory.end(), null);
  assert.equal(await memory.catchUp(), 0);
  assert.equal(llmCalls.length, 0);
});

test('enabling notes mid-meeting applies only to a new meeting', async () => {
  const { memory, llmCalls, setDestination } = harness({ destination: null });
  addConversation(memory);
  setDestination('test-provider');
  assert.equal(await memory.refreshNotes(), null);
  await memory.end();
  addConversation(memory);
  assert.ok(await memory.refreshNotes());
  assert.equal(llmCalls.length, 1);
});

test('clear/end without notes does not submit the transcript', async () => {
  const { memory, llmCalls } = harness();
  addConversation(memory);
  await memory.end({ writeNotes: false });
  assert.equal(llmCalls.length, 0);
  assert.equal(memory.current, null);
  assert.equal(await memory.catchUp(), 0, 'clearing cannot defer the upload until restart');
});

test('cancelled catch-up aborts the active request and never advances to another meeting', async () => {
  let resolve, signal;
  const pending = new Promise((done) => { resolve = done; });
  const { memory, store, llmCalls } = harness({ stream: (p) => { signal = p.signal; return pending; } });
  for (let i = 0; i < 2; i++) {
    addConversation(memory);
    const id = memory.current.id;
    await memory.end({ writeNotes: false });
    store.update(id, { notesSuppressed: false }); // fixture: approved, interrupted note generation
  }
  const catchUp = memory.catchUp();
  memory.cancelNotes();
  assert.equal(await catchUp, 0, 'cancellation does not await an unresponsive provider');
  assert.equal(signal.aborted, true);
  assert.equal(llmCalls.length, 1);
  resolve(NOTES);
  await new Promise(setImmediate);
  assert.ok(store.all().every((m) => !m.summary));
});

test('notes snapshot the submitted turns rather than marking later speech as summarized', async () => {
  let resolve;
  const { memory, store } = harness({ stream: () => new Promise((done) => { resolve = done; }) });
  addConversation(memory);
  const pending = memory.refreshNotes();
  memory.onTurn(turn('you', 'later speech', 1_000_003));
  resolve(NOTES);
  await pending;
  assert.equal(store.get(memory.current.id).notesTurns, 2);
});
