const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAnkerSync } = require('../src/anker-sync');
const token = `anker_call_${'a'.repeat(43)}`;
// Test cipher only: production uses Electron safeStorage and rejects basic_text.
const key = crypto.randomBytes(32);
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: s => { const iv=crypto.randomBytes(16); const c=crypto.createCipheriv('aes-256-cbc',key,iv); return Buffer.concat([iv,c.update(s),c.final()]); },
  decryptString: b => { const c=crypto.createDecipheriv('aes-256-cbc',key,b.subarray(0,16)); return Buffer.concat([c.update(b.subarray(16)),c.final()]).toString(); } };
function setup(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anker-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 100000;
  const options = { file: path.join(dir,'sync.enc'), safeStorage, now: () => clock, fetchImpl: handler };
  return { options, client: createAnkerSync(options), advance: () => { clock += 600000; } };
}
const identity = (userId='u',orgId='a') => ({ ok: true, json: async () => ({ scope:{userId,orgId,persona:'founder',workspace:'Company'},permissions:['calls:upload'] }) });
const capture = () => ({ title:'Call', transcript:'You: Please send the model. Other: Tomorrow.', consent:true, externalId:crypto.randomUUID() });
test('encrypted queue survives restart and lost responses retry with the same ID', async t => {
  const uploaded=[]; let fail=true;
  const {client,options,advance} = setup(t, async (url, req) => {
    assert.equal(url,'https://www.an-ker.de/api/calls/sync'); assert.equal(req.redirect,'error');
    if(req.method==='GET') return identity();
    uploaded.push(JSON.parse(req.body));
    if(fail) { fail=false; throw new Error('Lost response'); }
    return {ok:true,json:async()=>({call:{id:'server-call'},duplicate:true})};
  });
  await client.connect(token); client.enqueue(capture());
  const raw=fs.readFileSync(options.file).toString(); assert.ok(!raw.includes(token)); assert.ok(!raw.includes('Please send'));
  assert.ok(!JSON.stringify(client.status()).includes(token));
  await assert.rejects(client.upload(), /retained/); advance();
  const reopened=createAnkerSync(options); assert.equal(reopened.status().queue.length,1);
  await reopened.upload(); assert.equal(reopened.status().queue.length,0); assert.equal(uploaded[0].externalId,uploaded[1].externalId);
});
test('account changes, missing consent and insecure storage fail closed', async t => {
  let account='u'; const {client,options}=setup(t,async()=>identity(account));
  await client.connect(token);
  assert.throws(()=>client.enqueue({...capture(),consent:false}),/permission/);
  client.enqueue(capture()); account='someone-else';
  await assert.rejects(client.connect(token),/different account/);
  client.disconnect(); assert.equal(client.status().queue.length,1);
  await assert.rejects(client.upload(),/Connect Anker/);
  const insecure=createAnkerSync({...options,safeStorage:{...safeStorage,getSelectedStorageBackend:()=> 'basic_text'}});
  assert.throws(()=>insecure.status(),/Insecure/);
});
test('revocation retains pending transcripts; conflicts are blocked, never overwritten', async t => {
  let code=401;
  const {client,advance}=setup(t,async(_url,req)=>req.method==='GET'?identity():({ok:false,status:code,json:async()=>({})}));
  await client.connect(token); const value=capture(); client.enqueue(value);
  assert.throws(()=>client.enqueue(value),/already/);
  await assert.rejects(client.upload(),/Reconnect/); assert.equal(client.status().queue.length,1);
  code=409; advance(); await assert.rejects(client.upload(),/conflict/);
  assert.equal(client.status().queue[0].status,'blocked');
});
test('parallel operations are serialized and failed local persistence is never reported as saved', async t => {
  let release; const {client,options}=setup(t,()=>new Promise(resolve=>{release=resolve}));
  const connect=client.connect(token);
  await assert.rejects(client.connect(token),/running/); release(identity()); await connect;
  fs.mkdirSync(`${options.file}.tmp`);
  assert.throws(()=>client.enqueue(capture())); assert.equal(client.status().queue.length,0);
});
