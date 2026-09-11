// Does the same hls.js error appear against a REAL Jellyfin server? If so it is
// not ours.
const puppeteer = require('puppeteer');
const BASE='http://127.0.0.1:8096';
(async () => {
  const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  await p.evaluateOnNewDocument(() => {
    let real;
    Object.defineProperty(window, 'Hls', { configurable:true, get(){return real;}, set(v){ real=v;
      if (v && v.prototype && !v.__dbg) { v.__dbg=true; const o=v.prototype.trigger;
        v.prototype.trigger=function(e,d){ if(d&&d.details==='internalException')
          console.log('HLSDBG '+JSON.stringify({event:d.event,type:d.type,msg:d.err&&d.err.message})); return o.call(this,e,d); }; } } });
  });
  p.on('console', m => { const t=m.text(); if (/HLSDBG|HLS Error/.test(t)) console.log('[c]', t.slice(0,300)); });
  await p.goto(`${BASE}/web/`, { waitUntil:'networkidle2', timeout:60000 });
  await p.waitForFunction(() => !!window.ApiClient, { timeout: 30000 });
  await p.evaluate(async () => window.ApiClient.authenticateUserByName('qa-user','stdjflib'));
  // An mkv the browser cannot direct play, so the server transcodes to HLS.
  const id = '7f7fa8898296fa49c285b6f679fe9ae2';
  await p.goto(`${BASE}/web/#/details?id=${id}`, { waitUntil:'networkidle2', timeout:45000 });
  await new Promise(r=>setTimeout(r,3500));
  await p.evaluate(() => {
    const c=[...document.querySelectorAll('button')].filter(b=>/play/i.test(b.getAttribute('data-action')||'')||/btnPlay/.test(b.className));
    const btn=c.find(b=>b.offsetParent!==null)||c[0]; if(btn) btn.click();
  });
  await new Promise(r=>setTimeout(r,14000));
  console.log('video:', await p.evaluate(()=>{const v=document.querySelector('video');return v?{t:v.currentTime,src:v.currentSrc.slice(0,80)}:null;}));
  await b.close();
})();
