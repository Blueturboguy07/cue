const port=process.argv[2];
const list=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pg=list.find(t=>/index\.html/.test(t.url));
const ws=new WebSocket(pg.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
const ex=`JSON.stringify([...document.querySelectorAll('input,select,option,label,button,a,p,span,div')].filter(e=>e.children.length===0||e.tagName==='INPUT').filter(e=>/deepgram/i.test(e.outerHTML)).map(e=>e.outerHTML.slice(0,200)))`;
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:ex,returnByValue:true}}));
const m=await new Promise(r=>ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id===1)r(d)});
console.log(m.result.result.value);process.exit(0);
