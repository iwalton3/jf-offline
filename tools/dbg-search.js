// The exact /Items calls the search screen makes, in full.
const puppeteer = require('puppeteer');
const BASE='http://127.0.0.1:8096';
(async () => {
  const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox'] });
  const p = await b.newPage();
  let capture = false;
  p.on('request', r => {
    const u = new URL(r.url());
    if (!capture || u.origin !== BASE) return;
    if (!/\/Items$|\/Search\/Hints/i.test(u.pathname)) return;
    console.log(u.pathname + '?' + decodeURIComponent(u.search.slice(1)).split('&').join('\n     '));
    console.log('---');
  });
  await p.goto(`${BASE}/web/`, { waitUntil:'networkidle2', timeout:60000 });
  await p.waitForFunction(() => !!window.ApiClient, { timeout: 30000 });
  await p.evaluate(async () => window.ApiClient.authenticateUserByName('qa-user','stdjflib'));
  await p.goto(`${BASE}/web/#/search.html`, { waitUntil:'networkidle2', timeout:45000 }).catch(()=>{});
  await new Promise(r=>setTimeout(r,3000));
  capture = true;
  await p.evaluate(() => {
    const input = document.querySelector("input[type='search'], .searchfields input, #searchTextInput");
    if (!input) { console.log('NO INPUT'); return; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'passage');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r=>setTimeout(r,7000));
  await b.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
