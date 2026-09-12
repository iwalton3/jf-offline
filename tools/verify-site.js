/* Check an assembled site the way it will actually be served: a plain static
 * host, no request-time injection, mounted in a subdirectory.
 *
 * This is what stops a demo from deploying broken. Everything serve.py does at
 * request time has to already be in the files, and the base path has to work.
 *
 *   node tools/verify-site.js http://127.0.0.1:8094/jf-offline
 */
const puppeteer = require('puppeteer');

const SITE = (process.argv[2] || process.env.SITE || 'http://127.0.0.1:8094/jf-offline')
    .replace(/\/+$/, '');
const base = new URL(SITE).pathname.replace(/\/+$/, '');

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${SITE}/web/`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForFunction(() => !!window.PS_SCHEMA, { timeout: 30000 }).catch(() => {});

    const first = await page.evaluate(() => ({
        base: window.PS_SCHEMA && window.PS_SCHEMA.basePath,
        bootstrap: !!window.__phantom,
        ui: !!(window.__phantom && window.__phantom.ui),
        servers: (JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}').Servers || []).length,
        address: window.ApiClient ? window.ApiClient.serverAddress() : null
    }));
    check('the bootstrap is baked into index.html', first.bootstrap === true);
    check('the modal API is present', first.ui === true);
    check('the base path is derived from where it is served', first.base === base, first.base);
    check('the first visit finds the phantom server with no reload',
        first.servers === 1, `${first.servers} server(s) at ${first.address}`);

    await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 30000 }).catch(() => {});
    check('the service worker controls the page',
        await page.evaluate(() => !!navigator.serviceWorker.controller));

    const answers = await page.evaluate(async (b) => {
        const get = async (path) => {
            const res = await fetch(b + path);
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        return {
            system: await get('/System/Info/Public'),
            users: await get('/Users/Public'),
            items: await get('/Items?Recursive=true'),
            views: await get('/UserViews')
        };
    }, base);
    check('the phantom server answers under the base path',
        answers.system.status === 200 && answers.system.body
            && answers.system.body.ProductName === 'Phantom Jellyfin Server',
        answers.system.body && answers.system.body.ServerName);
    check('it answers the library endpoints too',
        answers.users.status === 200 && answers.items.status === 200 && answers.views.status === 200,
        `${answers.users.status}/${answers.items.status}/${answers.views.status}`);

    const signedIn = await page.evaluate(async () => {
        const r = await window.ApiClient.authenticateUserByName('Offline', '');
        return r.User && r.User.Id;
    }).catch((e) => 'ERROR: ' + e.message);
    check('signing in works', typeof signedIn === 'string' && signedIn.startsWith('0ff11e'), signedIn);

    const modal = await page.evaluate(async () => {
        await window.__phantom.ui.open();
        await new Promise((r) => setTimeout(r, 3000));
        const el = document.querySelector('.phantom-modal offline-sync-manager');
        const root = el && (el.shadowRoot || el);
        const ok = !!(root && /Downloaded|servers/i.test(root.textContent || ''));
        window.__phantom.ui.close();
        return ok;
    });
    check('the download manager opens as a modal', modal === true);

    const manifest = await page.evaluate(async (b) => {
        const res = await fetch(b + '/web/precache-manifest.json');
        const body = await res.json();
        // Spot-check that manifest paths are real, since a wrong base path here
        // makes the precache fetch two thousand 404s and never finish.
        const sample = body.files.filter((_f, i) => i % 400 === 0).slice(0, 6);
        const codes = [];
        for (const f of sample) codes.push((await fetch(f)).status);
        return { version: body.version, count: body.files.length, codes };
    }, base);
    check('the precache manifest lists files that exist',
        manifest.codes.length > 0 && manifest.codes.every((c) => c === 200),
        `${manifest.count} entries (${manifest.version}), sampled ${manifest.codes.join(',')}`);

    const real = errors.filter((e) => !/^Response$/.test(e));
    check('no uncaught page errors', real.length === 0, real.slice(0, 2).join(' | '));

    await browser.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
