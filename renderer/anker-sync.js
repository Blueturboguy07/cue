(() => {
  const $ = id => document.getElementById(id);
  let busy = false;
  function render(state) {
    $('anker-connection').textContent = state.connection ? `${state.connection.workspace} · ${state.connection.persona} · Account ${state.connection.userId}` : 'Not connected';
    const list = $('anker-queue-list');
    list.replaceChildren();
    for (const item of state.queue) {
      const row = document.createElement('div');
      const label = document.createElement('p');
      label.textContent = `${item.title} · ${item.characters} characters · ${item.status}${item.error ? ` · ${item.error}` : ''}${item.retryAt > Date.now() ? ' · Wait briefly before retrying' : ''}`;
      const remove = document.createElement('button');
      remove.textContent = 'Remove local queued copy';
      remove.onclick = () => run(() => window.cue.ankerRemove(item.id));
      row.append(label, remove); list.append(row);
    }
    if (!state.queue.length) list.textContent = 'No queued calls. Confirmed uploads are removed from this queue.';
  }
  async function run(action, message) {
    if (busy) return;
    busy = true;
    const buttons = [...document.querySelectorAll('[data-pane="anker"] button')];
    buttons.forEach(button => { button.disabled = true; });
    $('anker-status').textContent = 'Working…';
    try { const state = await action(); if (state?.queue) render(state); $('anker-status').textContent = message || 'Connection status updated.'; }
    catch (error) { $('anker-status').textContent = error.message || 'Anker operation failed. Your queue is retained.'; try { render(await window.cue.ankerStatus()); } catch {} }
    finally { busy = false; document.querySelectorAll('[data-pane="anker"] button').forEach(button => { button.disabled = false; }); }
  }
  $('anker-connect').onclick = () => run(async () => { const key = $('anker-key').value.trim(); $('anker-key').value = ''; return window.cue.ankerConnect(key); }, 'Connected. Check the workspace above before queueing a call.');
  $('anker-disconnect').onclick = () => run(() => window.cue.ankerDisconnect(), 'Disconnected. Queued calls remain bound to their original account. Revoke this device in Anker to invalidate its key.');
  $('anker-refresh').onclick = () => run(() => window.cue.ankerStatus());
  $('anker-preview').onclick = () => run(async () => { const result = await window.cue.ankerPreview(); $('anker-transcript').textContent = result.transcript || 'No transcript yet.'; if (result.overflow) throw new Error('Capture exceeded the upload limit; partial sync is blocked.'); }, 'Review the transcript before queueing.');
  $('anker-queue').onclick = () => run(async () => { const state = await window.cue.ankerQueue({ title: $('anker-title').value.trim(), consent: $('anker-consent').checked }); $('anker-consent').checked = false; return state; }, 'Capture saved to the encrypted queue. Choose Upload queued calls when ready.');
  $('anker-upload').onclick = () => run(() => window.cue.ankerUpload(), 'Upload pass finished. Pending retries remain in the queue. Open Anker to review saved calls.');
  document.querySelector('[data-tab="anker"]').addEventListener('click', () => run(() => window.cue.ankerStatus()));
})();
