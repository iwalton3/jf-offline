# Phantom Jellyfin Server

A service worker that impersonates a Jellyfin server well enough that an
**unmodified, unrecompiled jellyfin-web** browses and plays a library held
entirely in the browser.

Downloads are pulled from the real Jellyfin servers the user is already signed in
to, stored in the origin private file system, and served back over ranged HTTP
that the app cannot tell from a server on the network.

This is a v0 spike. See `SCOPE.md` for what it deliberately does not do.

## Running it

```sh
# once: build jellyfin-web (any recent checkout)
cd ~/Desktop/jellyfin-web && npm run build:production

# then
python3 serve.py                      # http://127.0.0.1:8099/web/
```

Open the app, sign in as **Offline** (no password), then add your real server from
the server-selection screen and sign in to it. Dashboard → Offline Sync is the
download manager.

## The whole change to jellyfin-web

Two files in the built output, neither of them application code:

| file | change |
|---|---|
| `dist/serviceworker.js` | replaced with the phantom server |
| `dist/config.json` | `multiserver` set to `true` |

`serve.py` does not copy them over the build. It serves `overlay/` in front of
`dist/`, so the overlay directory **is** the diff.

### Offline, properly

The app itself is held offline, not just the media. jellyfin-web is two thousand
lazily-loaded chunks, so caching on demand leaves every route nobody visited
broken in airplane mode, and there is no way to know in advance which those are.
The host publishes `/web/precache-manifest.json` (a build artifact in a real
deployment) and the worker holds the lot — about 55 MB — resumably in the
background, because a worker doing that many fetches will be killed part-way. The
settings page shows the progress.

### Two things the host must do

Both exist because they have to happen *before* the worker does, and a static
host can do both.

0. Publish `/web/precache-manifest.json`, as above.
1. **Answer `GET /System/Info/Public`** with the phantom server's identity — one
   JSON file. jellyfin-web probes for a server during boot and registers the
   worker only afterwards, so on a first visit the probe has nobody to talk to,
   the app settles on "no servers", and nothing ever retries it. Measured in
   Firefox 140 on a fresh profile: without this the first visit logs
   `Begin connectToServers, with 0 servers` and the second logs 1.
2. **Inject four `<script>` tags into `index.html`**, so the page that installs
   the worker already has the WebSocket stand-in.

`serve.py` reads the server id out of `overlay/ps/schema.js` rather than
restating it, because two spellings would disagree the first time one changed and
the app would hold a server it could never match.

## Why it works

Four things jellyfin-web already does, none of them added for us:

- **It finds the server by itself.** With no client configured, `serverAddress()`
  cuts everything from the last `/web` off its own URL and probes
  `/System/Info/Public` on what remains (`src/utils/dashboard.js:36`). Serving the
  app at `/web/` and the phantom server at the origin root is all the
  configuration there is.
- **It registers the worker at the scope that matters.**
  `navigator.serviceWorker.register('serviceworker.js')` with no scope option
  (`src/index.jsx:197`) yields scope `/web/`. Scope decides which *pages* a worker
  controls, not which URLs it may answer, so controlling `/web/index.html` means
  seeing every request that page makes — including `/Items` and `/Videos` at the
  root.
- **It executes server-supplied JavaScript for plugin settings pages.**
  `ServerContentPage` fetches HTML from `/web/configurationpage?name=X`
  (`routes.tsx:49`) and `viewContainer` resolves the page's `data-controller`
  through `importModule` against the same server (`viewContainer.js:22`). That is
  where the download manager lives, written in vdx-web.
- **It decides playback entirely from one JSON response.** The player never
  inspects the file; the branch it takes is fixed by the MediaSource flags
  (`playbackmanager.js:2884`).

## Layout

```
serve.py              dev host: overlay/ in front of dist/, plus the two things above
overlay/              the diff against an unmodified build
  serviceworker.js      the phantom server (also loaded as a page script — see below)
  config.json           multiserver: true
  ps-bootstrap.js       runs in the page before jellyfin-web: the WebSocket stand-in
  ps/                   worker modules, classic scripts via importScripts
    schema.js             ids, storage layout, shared constants
    db.js                 IndexedDB
    opfs.js               media bytes
    http.js               responses, case-insensitive params, ranged reads
    library.js            query engine and the browse/detail handlers
    playback.js           PlaybackInfo, streaming, play state
    plugin.js             the Offline Sync settings page
    notify.js             pushes into the page over the socket stand-in
    router.js             the route table
  plugin/               the download manager UI (vdx-web, no build step)
  diag.html             dev page: does the phantom server work in THIS browser
tools/
  probe-requests.js     records what jellyfin-web really asks for, against a real server
  smoke.js              end-to-end test in a real browser
```

`schema.js`, `db.js` and `opfs.js` are loaded in **both** contexts — `importScripts`
in the worker, and `<script>` tags the worker injects into `index.html` for the
page — so the downloader and the server share one schema rather than two copies.

## Things that will surprise you

- **`serviceworker.js` is also loaded as an ordinary page script.** jellyfin-web's
  build lists the serviceworker chunk in HtmlWebpackPlugin's `chunks`
  (`webpack.common.js:74`), so `index.html` carries a
  `<script defer src="serviceworker.js">`. Upstream that is inert. Anything that
  only exists in a worker has to sit behind the `IS_SERVICE_WORKER` guard.
- **`document.createElement` is patched.** jellyfin-web bundles the webcomponents
  ES5 shim, which builds elements its own way and never upgrades a custom element
  made through it. Create custom elements through the parser (`innerHTML`) or the
  native constructor.
- **Query parameter case is not consistent.** The same screen sends both
  `IncludeItemTypes` and `includeItemTypes`. `PS_HTTP.Params` reads
  case-insensitively; anything that does not will work on one screen and
  mysteriously not on the next.
- **A worker cannot intercept a WebSocket.** There is no hook. jellyfin-web will
  definitely open one, because every item grid subscribes to `UserDataChanged` on
  mount (`emby-itemscontainer.js:294`), and the SDK then reconnects forever on
  exponential backoff (`websocket-service.js:92`). `ps-bootstrap.js` stands in for
  it, which stops the loop and provides the push channel play state travels on.
- **Auth on 12.0 goes in the `Authorization` header.** The `api_key` query
  parameter is refused by `/Items/{id}/Download` and by the HLS playlist
  endpoints, which are exactly the two a download needs.
- **Downloads run in the page, not the worker.** A worker is killed after a short
  idle and takes the download with it.
- **jellyfin-web loads a 2015 custom-elements polyfill** (webcomponents.js 0.7),
  because every one of its `emby-*` elements is registered through
  `document.registerElement`. That polyfill replaces `document.createElement`, and
  an element made through the replacement is never upgraded by the *native*
  registry. Measured in the page: the parser and `importNode` upgrade correctly
  and only `createElement` does not, so `tools/sync-vdx.sh` rewrites that one call
  in the copied vdx sources. Unpatching globally would break jellyfin-web itself.
- **The router matches on a lower-cased path**, so handlers receive lower-cased
  captures. Image types are written by the downloader with Jellyfin's own
  capitalisation, so `paths.image` normalises; anything else that round-trips a
  capture through storage has to do the same.
- **Cache-first is only safe for a URL that pins its content.** jellyfin-web's
  bundles carry a content hash; the overlay's files do not, so they are served
  network-first. Cached first, they serve last session's module forever, and the
  symptom is an import failing for an export that is plainly in the file on disk.
- **IndexedDB refuses to clone a Proxy.** vdx holds component state in reactive
  proxies, so an item taken out of the settings page's list cannot be stored
  as-is. The downloader converts at its own front door; a test that does not go
  through the UI will never see this.

## Tests

```sh
python3 serve.py &                                  # needs a real Jellyfin on :8096
NODE_PATH=/working/mrepo-web/tests/node_modules node tools/smoke.js
```

The suite runs in a real browser, including both download modes, ranged media
reads, play state direction, the settings page mounting inside the app, and the
whole thing working with the network switched off.

`overlay/diag.html` answers "does this browser work" without jellyfin-web in the
way, and prints to the console as well as the page, so it also runs under
`firefox --headless` with `devtools.console.stdout.content` set.
`tools/ff-console.js` is the same questions as a paste-into-the-console snippet.

`tools/probe-requests.js` regenerates the ground truth about which endpoints each
screen asks for. Run it against a real server rather than reading jellyfin-web,
and add what it finds.
