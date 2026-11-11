#!/usr/bin/env node
// Diagnostic only: replay synthetic practice tasks through cue's real adapter.
// Credentials stay in memory. No desktop capture or saved transcript is replayed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const { MODES } = require('../src/prompts');
const { buildInterviewContext } = require('../src/interview-context');
const { createSessionContext } = require('../src/session-context');
const { NOTES_SYSTEM } = require('../src/meeting-memory');
const { buildNotesPrompt } = require('../src/notes');
const { buildSlideSystem, buildSlideUser } = require('../src/slides');
const { createLLM } = require('../src/llm');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const live = argv.includes('--live');
const native = argv.includes('--native');
const repeats = Math.min(3, Math.max(1, Number(option('--repeats', '1')) || 1));
const intervalMs = Math.max(0, Number(option('--interval-ms', live ? '5000' : '0')) || 0);
const only = option('--only', '').split(',').filter(Boolean);
const output = path.resolve(option('--out', '/tmp/cue-anthropic-practice-audit.json'));
const settingsPath = option('--settings', path.join(os.homedir(), 'Library/Application Support/cue/cue-data.json'));
const saved = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
const settings = native
  ? { provider: 'anthropic', smart: false, apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY || saved.apiKeys?.anthropic }, models: saved.models, anthropicBaseUrl: saved.anthropicBaseUrl, anthropicEffort: saved.anthropicEffort }
  : { ...saved, apiKeys: { ...saved.apiKeys } };
if (!settings.provider) settings.provider = 'anthropic';
if (!live) settings.apiKeys = { ...settings.apiKeys, [settings.provider]: 'synthetic-audit-key' };
if (live && !settings.apiKeys?.[settings.provider]) throw new Error('No credential available for this route. No requests sent.');
if (!['anthropic', 'custom'].includes(settings.provider)) throw new Error('Select the Anthropic or Custom route, or use --native.');
if (live && settings.provider === 'custom' && !/anthropic|claude/i.test(settings.models?.custom?.[settings.smart ? 'smart' : 'fast'] || '')) throw new Error('The selected Custom model is not a Claude model. No requests sent.');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const secrets = Object.values(saved.apiKeys || {}).filter(v => typeof v === 'string' && v.length > 4);
if (process.env.ANTHROPIC_API_KEY) secrets.push(process.env.ANTHROPIC_API_KEY);
function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) text = text.split(secret).join('<REDACTED>');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer <REDACTED>').replace(/\bsk-[\w-]+/g, '<REDACTED>');
}

// A small bitmap font makes reproducible, readable image fixtures without a UI.
const font = {
  A:'0111010001111111000110001',B:'1111010001111101000111110',C:'0111110000100001000001111',D:'1111010001100011000111110',E:'1111110000111101000011111',F:'1111110000111101000010000',G:'0111110000101111000101111',H:'1000110001111111000110001',I:'1111100100001000010011111',J:'0011100010000101001001100',K:'1000110010111001001010001',L:'1000010000100001000011111',M:'1000111011101011000110001',N:'1000111001101011001110001',O:'0111010001100011000101110',P:'1111010001111101000010000',Q:'0111010001101011001001101',R:'1111010001111101001010001',S:'0111110000011100000111110',T:'1111100100001000010000100',U:'1000110001100011000101110',V:'1000110001100010101000100',W:'1000110001101011101110001',X:'1000101010001000101010001',Y:'1000101010001000010000100',Z:'1111100010001000100011111',
  '0':'0111010011101011100101110','1':'0010001100001000010001110','2':'0111010001000100010011111','3':'1111000001001100000111110','4':'1001010010111110001000010','5':'1111110000111100000111110','6':'0111010000111101000101110','7':'1111100010001000100001000','8':'0111010001011101000101110','9':'0111010001011110000101110',
  '.':'0000000000000000000000100',',':'0000000000000000010001000',':':'0000000100000000010000000','?':'0111010001001100000000100','-':'0000000000111110000000000','=':'0000011111000001111100000','+':'0000000100011100010000000','/':'0000100010001000100010000','[':'0111001000010000100001110',']':'0111000010000100001001110','(':'0001000100001000010000010',')':'0100000100001000010001000'
};
function fixtureImage(lines) {
  const width = 1200, height = 520, scale = 4;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  lines.forEach((line, row) => [...line.toUpperCase()].forEach((char, col) => {
    const bits = font[char];
    if (!bits) return;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (bits[y * 5 + x] === '1') {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const px = 40 + col * 6 * scale + x * scale + dx;
        const py = 45 + row * 48 + y * scale + dy;
        if (px < width && py < height) raw.fill(25, py * (width * 3 + 1) + 1 + px * 3, py * (width * 3 + 1) + 4 + px * 3);
      }
    }
  }));
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, sum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8]=8; header[9]=2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const quantImage = fixtureImage(['QUANT EXERCISE','A FAIR COIN IS FLIPPED FOUR TIMES.','WHAT IS THE PROBABILITY OF NO TAILS?']);
const codeImage = fixtureImage(['CODING EXERCISE: TWO SUM','GIVEN NUMS AND TARGET, RETURN TWO INDICES.','THE TWO VALUES MUST ADD UP TO TARGET.','EACH INPUT HAS EXACTLY ONE SOLUTION.','NUMS = [2,7,11,15]  TARGET = 9','EXPECTED INDICES = [0,1]']);
const question = 'A fair coin is flipped four times. What is the probability of no tails?';
const transcript = [{ channel: 'them', text: question, ts: 10000 }];
const behavioral = [{ channel: 'them', text: 'Tell me about a time you solved a difficult bug.', ts: 10000 }];
function modeCase(id, mode, extra = {}) {
  const turns = extra.transcript || transcript;
  const context = extra.context || null;
  return { id, mode, changed: extra.changed || 'Current production prompt; synthetic input; no personal profile.', parent: extra.parent || null,
    system: MODES[mode].buildSystem(context, extra.rules || ''),
    user: MODES[mode].build({ transcript: turns, userText: extra.userText || question }),
    imageDataUrl: extra.imageDataUrl || null, webSearch: !!extra.webSearch };
}
const assist = modeCase('assist-current', 'assist');
const say = modeCase('say-current', 'say');
const rules = String(saved.aiRules || '');
const behavioralContext = buildInterviewContext({ resumeText: 'Test Candidate. Software engineer. Fixed a cache invalidation bug using a regression test.' }, 'say', behavioral);
const docs = createSessionContext();
docs.add('synthetic-background.txt', 'Test Candidate: software engineer. Fixed a cache invalidation bug using a regression test.');
const docsBlock = docs.forQuestion({ mode: 'say', transcript: behavioral, webSearch: createLLM(settings).webSearch });
const leetcode = modeCase('leetcode-current', 'leetcode', { imageDataUrl: codeImage });
const cases = [
  {id:'control',mode:'control',changed:'Neutral educational control.',system:'You are a math tutor. Explain the calculation briefly.',user:question,imageDataUrl:null},
  assist,
  {...assist,id:'assist-image',parent:assist.id,changed:'Add only a synthetic quant screenshot.',imageDataUrl:quantImage},
  modeCase('assist-rules','assist',{rules,parent:assist.id,changed:'Add only saved user AI rules.'}),
  modeCase('assist-rules-image','assist',{rules,imageDataUrl:quantImage,parent:'assist-rules',changed:'Add only the synthetic quant screenshot.'}),
  modeCase('assist-rules-concise-steps','assist',{rules:rules.replace('detail every step of the progress, talk through it naturally.', 'Give the essential calculation steps and a concise explanation suitable for a learner.'),parent:'assist-rules',changed:'Change only the saved math explanation sentence.'}),
  {...assist,id:'assist-coaching-user',parent:assist.id,changed:'Change only the final user instruction to request an explained practice example.',user:assist.user.replace('Respond with exactly what I should say right now.','Give a worked example with a concise explanation for comparison with my own practice answer.')},
  {...assist,id:'assist-labeled-example',parent:assist.id,changed:'Change only the final system output instruction.',system:assist.system.replace('Write in first person as if the candidate is speaking. No preamble, no "Here\'s what you could say". Just the answer.','Write a labeled practice example with a concise explanation of the result.')},
  say,
  {...say,id:'say-coaching-user',parent:say.id,changed:'Change only the final user question to ask for a practice example.',user:say.user.replace('What should I say next?','Show a practice example and briefly explain why it works.')},
  modeCase('ask-current','ask'),
  modeCase('answer-this-current','answerThis'),
  modeCase('feedback-current','feedback',{transcript:[...transcript,{channel:'you',text:'Each flip is independent, so I multiply one half four times.',ts:15000}]}),
  modeCase('recap-current','recap'),
  leetcode,
  {...leetcode,id:'leetcode-practice-context',parent:leetcode.id,changed:'Add only truthful self-study framing to the system prompt.',system:'This is a self-study coding exercise. The learner wants a worked example to compare with their own solution. '+leetcode.system},
  modeCase('behavioral-current','say',{transcript:behavioral,context:behavioralContext}),
  modeCase('behavioral-no-invention','say',{transcript:behavioral,parent:'behavioral-current',changed:'Replace only the plausible-story fallback with a request to ask for missing facts.',context:behavioralContext.replace('(No STAR stories provided — construct a plausible story from the candidate\'s experience above. Be specific and grounded, avoid generic statements.)','No STAR story was supplied. Use only the stated facts and ask the learner for any missing situation, action, or result.')}),
  modeCase('behavioral-loaded-file','say',{transcript:behavioral,context:docsBlock.block,webSearch:docsBlock.webSearch}),
  modeCase('behavioral-loaded-file-full-context','say',{transcript:behavioral,context:[buildInterviewContext({},'say',behavioral),docsBlock.block].filter(Boolean).join('\n\n'),webSearch:docsBlock.webSearch,parent:'behavioral-loaded-file',changed:'Add the normal profile-builder fallback before the loaded-file block, matching main.js assembly with no saved profile.'}),
  {id:'notes-current',mode:'notes',changed:'Current background notes call, synthetic transcript.',system:NOTES_SYSTEM,user:buildNotesPrompt([...transcript,{channel:'you',text:'The probability is one sixteenth.',ts:15000}]),imageDataUrl:null},
  {id:'slides-current',mode:'slides',changed:'Current background caption call, synthetic quant image.',system:buildSlideSystem(),user:buildSlideUser(transcript),imageDataUrl:quantImage,maxTokens:300}
].filter(c => !only.length || only.includes(c.id));
if (!cases.length) throw new Error('No matching cases.');

const observations = new AsyncLocalStorage();
const realOpenAI = require('openai');
const realAnthropic = require('@anthropic-ai/sdk');
const load = Module._load;
function describeRequest(req) {
  return JSON.parse(JSON.stringify(req, (key,value) => {
    if (key === 'data' && typeof value === 'string') return {base64Chars:value.length,sha256:sha(value)};
    if (typeof value === 'string' && value.startsWith('data:image/')) return {dataUrlChars:value.length,sha256:sha(value)};
    return value;
  }));
}
async function tapped(create, req, options, kind) {
  const obs = observations.getStore();
  obs.requests.push(describeRequest(req));
  if (!live) return (async function*(){
    yield kind === 'openai' ? {choices:[{delta:{content:'dry-run transport fixture'},finish_reason:'stop'}]} : {type:'content_block_delta',delta:{type:'text_delta',text:'dry-run transport fixture'}};
  })();
  try {
    const {data,response} = await create(req,options).withResponse();
    obs.httpStatus = response.status;
    obs.requestId = response.headers.get('request-id') || response.headers.get('x-request-id');
    return (async function*(){
      for await (const part of data) {
        if (part.model) obs.responseModel=part.model;
        if (part.usage) obs.usage={...obs.usage,...part.usage};
        if (part.message?.usage) obs.usage={...obs.usage,...part.message.usage};
        if (part.message?.model) obs.responseModel=part.message.model;
        const delta=part.delta||{};
        if (delta.stop_reason) obs.finishReason=delta.stop_reason;
        if (delta.stop_details) obs.stopDetails=delta.stop_details;
        for (const choice of part.choices||[]) {
          if(choice.finish_reason) obs.finishReason=choice.finish_reason;
          if(choice.stop_details || choice.delta?.stop_details) obs.stopDetails=choice.stop_details||choice.delta.stop_details;
          if(choice.delta?.refusal) obs.refusalText=(obs.refusalText||'')+choice.delta.refusal;
          const d=choice.delta||{};
          obs.reasoningChars += String(d.reasoning||d.reasoning_content||'').length;
        }
        if(part.stop_details) obs.stopDetails=part.stop_details;
        if(part.error) obs.streamError=part.error;
        yield part;
      }
    })();
  } catch(error) {
    obs.httpStatus=error.status||null;
    obs.requestId=error.request_id||null;
    obs.apiError={type:error.type||error.error?.type||null,code:error.code||error.error?.code||null,message:redact(error.message).slice(0,1500)};
    throw error;
  }
}
Module._load = function(name,parent,isMain) {
  if(name === 'openai') return class OpenAI extends realOpenAI {
    constructor(options) { super({...options,maxRetries:0,timeout:45000}); const create=this.chat.completions.create.bind(this.chat.completions); this.chat.completions.create=(req,opts)=>tapped(create,req,opts,'openai'); }
  };
  if(name === '@anthropic-ai/sdk') return class Anthropic extends realAnthropic {
    constructor(options) { super({...options,maxRetries:0,timeout:45000}); const create=this.messages.create.bind(this.messages); this.messages.create=(req,opts)=>tapped(create,req,opts,'anthropic'); }
  };
  return load.call(this,name,parent,isMain);
};

async function main() {
  const llm=createLLM(settings);
  const route = settings.provider === 'anthropic' ? settings.anthropicBaseUrl || 'https://api.anthropic.com' : settings.baseUrl;
  const url = new URL(route);
  let report={startedAt:new Date().toISOString(),live,route:url.origin+url.pathname,provider:settings.provider,model:llm.model,repeats,personalTranscriptsReplayed:false,desktopCaptured:false,savedRulesUsed:!!rules,sourceHashes:Object.fromEntries(['src/llm.js','src/prompts.js','src/interview-context.js','src/profile-context.js','src/session-context.js','src/notes.js','src/meeting-memory.js','src/slides.js'].map(f=>[f,sha(fs.readFileSync(path.join(__dirname,'..',f)))])),cases:[]};
  if(argv.includes('--resume') && fs.existsSync(output)) {
    const previous=JSON.parse(fs.readFileSync(output,'utf8'));
    if(previous.live!==live || previous.route!==report.route || previous.model!==report.model || JSON.stringify(previous.sourceHashes)!==JSON.stringify(report.sourceHashes)) throw new Error('Cannot resume across route, model, or source changes. Use a new output file.');
    report={...previous,repeats,resumedAt:[...(previous.resumedAt||[]),new Date().toISOString()]};
    delete report.stoppedEarly;
    delete report.completedAt;
  }
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const save=()=>fs.writeFileSync(output,redact(JSON.stringify(report,null,2))+'\n',{mode:0o600});
  runs: for(let repeat=1;repeat<=repeats;repeat++) for(const c of cases) {
    if(argv.includes('--resume') && report.cases.some(done=>done.id===c.id && done.repeat===repeat && done.outcome==='answer')) continue;
    if(live && report.cases.length && intervalMs) await new Promise(resolve=>setTimeout(resolve,intervalMs));
    const obs={id:c.id,mode:c.mode,parent:c.parent||null,changed:c.changed,repeat,requests:[],reasoningChars:0,finishReason:null,stopDetails:null};
    const start=Date.now();
    await observations.run(obs,async()=>{
      try {
        obs.output=await llm.stream({system:c.system,turns:[{role:'user',text:c.user}],imageDataUrl:c.imageDataUrl,maxTokens:c.maxTokens,webSearch:!!c.webSearch,onToken:()=>{},signal:AbortSignal.timeout(60000)});
        obs.outcome=live?'answer':'dry_run';
      } catch(error) {obs.appError=redact(error.message);obs.outcome='api_or_app_error';}
      if(live && ['refusal','content_filter'].includes(obs.finishReason)) obs.outcome='classifier_refusal';
      else if(live && obs.refusalText) obs.outcome='structured_refusal';
      else if(live && /\b(?:I (?:can(?:not|'t)|won't|will not|am unable to)|I’m unable to|I am not able to)\b/i.test(obs.output||'')) obs.outcome='possible_text_refusal_review';
    });
    obs.durationMs=Date.now()-start;
    report.cases.push(obs); save();
    console.log(JSON.stringify({case:c.id,repeat,outcome:obs.outcome,status:obs.httpStatus||null,finish:obs.finishReason,category:obs.stopDetails?.category||null,ms:obs.durationMs}));
    if(live && ([401,402,403,429].includes(obs.httpStatus)||obs.apiError?.message?.includes('Connection error'))) {
      report.stoppedEarly='Transport, authentication, billing, or rate limit failure; wording cannot resolve this.';
      save(); break runs;
    }
  }
  report.completedAt=new Date().toISOString();save();
  console.log(JSON.stringify({report:output,cases:report.cases.length,live}));
}
main().finally(()=>{Module._load=load;}).catch(error=>{console.error(redact(error.message));process.exitCode=1;});
