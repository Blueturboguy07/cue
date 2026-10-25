// usage: node cdp.mjs <port>; exit 0 if main UI DOM mentions Deepgram, 1 if not, 2 if cannot observe
const port=process.argv[2];
const list=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pg=list.find(t=>t.type==='page'&&/index\.html/.test(t.url));
if(!pg){console.log('EVIDENCE: pages='+list.map(t=>t.url.split('/').pop()).join(','));process.exit(2);}
const ws=new WebSocket(pg.webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
const ask=(expression)=>{ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));return new Promise(r=>{ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id===1)r(d)}})};
let m;
for(let i=0;i<15;i++){m=await ask('String(!!document.querySelector("#key-deepgram"))');if(m.result.result.value==='true')break;await new Promise(r=>setTimeout(r,1000));}
m=await ask('String(!!document.querySelector("#key-deepgram")&&!!document.querySelector("[data-stt-provider=deepgram]")&&/deepgram uses the key from the API Keys tab/i.test(document.body.textContent))');
const v=m.result&&m.result.result&&m.result.result.value;
if(v!=='true'&&v!=='false'){console.log('EVIDENCE: evaluate failed '+JSON.stringify(m).slice(0,200));process.exit(2);}
console.log('EVIDENCE: main window DOM Audio tab offers Deepgram provider + points to API Keys tab for the key = '+v);
process.exit(v==='true'?0:1);
