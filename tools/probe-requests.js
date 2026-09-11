// Records every API request jellyfin-web issues on the screens we intend to fake.
// Run against a real server so the shapes are observed, not guessed.
const puppeteer = require('puppeteer');

const BASE = process.env.JF_BASE || 'http://127.0.0.1:8096';
const USER = process.env.JF_USER || 'qa-user';
const PASS = process.env.JF_PASS || 'stdjflib';

const hits = [];
let phase = 'boot';

const log = (...a) => console.error('[probe]', ...a);

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    page.on('request', req => {
        const u = new URL(req.url());
        if (u.origin !== new URL(BASE).origin) return;
        if (u.pathname.startsWith('/web/')) return;
        hits.push({ phase, method: req.method(), path: u.pathname, query: [...u.searchParams.keys()].sort() });
    });

    const goto = async (hash, label, waitMs = 4000) => {
        phase = label;
        log('->', label, hash);
        await page.goto(`${BASE}/web/${hash}`, { waitUntil: 'networkidle2', timeout: 45000 }).catch(e => log('nav warn', e.message));
        await new Promise(r => setTimeout(r, waitMs));
        log('   at', await page.evaluate(() => location.hash || location.pathname));
    };

    // Sign in through the app's own code path rather than guessing at its credential
    // format: ApiClient.authenticateUserByName fires the event connectionManager uses
    // to persist credentials, so the session is exactly what a real login produces.
    phase = 'auth';
    await page.goto(`${BASE}/web/`, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForFunction(() => !!window.ApiClient, { timeout: 30000 });
    const auth = await page.evaluate(async (user, pass) => {
        const r = await window.ApiClient.authenticateUserByName(user, pass);
        return { AccessToken: r.AccessToken, User: r.User, ServerId: r.ServerId };
    }, USER, PASS);
    log('authenticated as', auth.User && auth.User.Name);

    // Discover real ids to navigate to.
    const ids = await page.evaluate(async (base, token, userId) => {
        const h = { Authorization: `MediaBrowser Token="${token}"` };
        const j = async u => (await fetch(base + u, { headers: h })).json();
        const views = await j(`/UserViews?userId=${userId}`);
        const movieView = views.Items.find(v => v.CollectionType === 'movies');
        const tvView = views.Items.find(v => v.CollectionType === 'tvshows');
        const movies = await j(`/Items?userId=${userId}&IncludeItemTypes=Movie&Recursive=true&Limit=1`);
        const series = await j(`/Items?userId=${userId}&IncludeItemTypes=Series&Recursive=true&Limit=1`);
        const seriesId = series.Items[0] && series.Items[0].Id;
        const seasons = seriesId ? await j(`/Shows/${seriesId}/Seasons?userId=${userId}`) : { Items: [] };
        return {
            movieViewId: movieView && movieView.Id,
            tvViewId: tvView && tvView.Id,
            movieId: movies.Items[0] && movies.Items[0].Id,
            seriesId,
            seasonId: seasons.Items[0] && seasons.Items[0].Id
        };
    }, BASE, auth.AccessToken, auth.User.Id);
    log('ids', JSON.stringify(ids));

    await goto('#/home.html', 'home', 6000);
    if (ids.movieViewId) await goto(`#/movies.html?topParentId=${ids.movieViewId}`, 'browse-movies', 5000);
    if (ids.movieId) await goto(`#/details?id=${ids.movieId}`, 'detail-movie', 5000);
    if (ids.tvViewId) await goto(`#/tv.html?topParentId=${ids.tvViewId}`, 'browse-shows', 5000);
    if (ids.seriesId) await goto(`#/details?id=${ids.seriesId}`, 'detail-series', 5000);
    if (ids.seasonId) await goto(`#/details?id=${ids.seasonId}`, 'detail-season', 5000);

    await browser.close();

    // Collapse to unique shapes, keeping which screen asked for each.
    const byShape = new Map();
    for (const h of hits) {
        const path = h.path.replace(/\/[0-9a-f]{32}\b/gi, '/{id}');
        const key = `${h.method} ${path}`;
        if (!byShape.has(key)) byShape.set(key, { key, phases: new Set(), query: new Set() });
        const e = byShape.get(key);
        e.phases.add(h.phase);
        h.query.forEach(q => e.query.add(q));
    }
    const out = [...byShape.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(e => ({ endpoint: e.key, screens: [...e.phases], params: [...e.query].sort() }));
    console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
