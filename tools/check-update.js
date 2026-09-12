/* Does a change to worker-side code reach the user, and after how many loads?
 *
 * Not part of the suite: it edits a source file and needs the dev host pointed
 * at the working tree, so it is run by hand when the update path is in question.
 *
 *   node tools/check-update.js
 *
 * Measured on Chrome 121: the load that finds the change installs a new worker,
 * and the load after that runs it. skipWaiting() does not shorten this, from the
 * install handler or from a message — see ps-bootstrap.js. */
const puppeteer = require('puppeteer');
const fs = require('fs');
const APP = 'http://127.0.0.1:8099';
const FILE = '/working/jf-offline/overlay/ps/router.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const marker = (p) => p.evaluate(async () => {
  try { return (await (await fetch('/marker')).json()).marker; } catch { return 'absent'; }
});

(async () => {
  const original = fs.readFileSync(FILE, 'utf8');
  const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox'] });
  const p = await b.newPage();
  try {
    await p.goto(`${APP}/web/`, { waitUntil:'networkidle2', timeout:60000 });
    await p.waitForFunction(() => !!window.PS_SCHEMA, { timeout: 25000 });
    await p.reload({ waitUntil:'networkidle2', timeout:60000 });
    await p.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 25000 });
    await sleep(2000);
    console.log('before change, marker route:', await marker(p));

    fs.writeFileSync(FILE, original.replace(
      "        ['GET', /^\\/system\\/endpoint$/,",
      "        ['GET', /^\\/marker$/, () => json({ marker: 'v2' })],\n        ['GET', /^\\/system\\/endpoint$/,"
    ));
    console.log('changed ps/router.js; serviceworker.js untouched');

    // One reload, as a person restarting the app.
    await p.reload({ waitUntil:'networkidle2', timeout:60000 }).catch(() => {});
    await sleep(8000);
    console.log('after ONE reload:', JSON.stringify(await p.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: !!reg.waiting, active: reg.active && reg.active.state };
    })), '| marker:', await marker(p));

    await p.reload({ waitUntil:'networkidle2', timeout:60000 }).catch(() => {});
    await sleep(5000);
    console.log('after a second reload: marker:', await marker(p));
  } finally {
    fs.writeFileSync(FILE, original);
    await b.close();
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
