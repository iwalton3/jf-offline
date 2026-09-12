# Experimental Offline Sync for Jellyfin Web

This is an experimental Jellyfin-Web build with Offline Sync added.

![Screenshot](https://raw.githubusercontent.com/iwalton3/mpv-shim-misc-docs/refs/heads/master/images/jf-offline.png)

[Try it out here.](https://iwalton3.github.io/jf-offline/) or [Download](https://nightly.link/iwalton3/jf-offline/workflows/pages/main/jf-offline-bundle.zip)

Quick start:
- To download files, use the "Sync Offline" option on media items.
- To manage downloads, use the "Manage Downloads" user menu option.
- To switch to the offline catalog, use the "Select Server" user menu option.

Features:
- Works on Google Chrome and Firefox, both on Desktop and Android
- Full "Airplane Mode" offline support.
- Simulates a Jellyfin server locally using an offline service worker
- Actual working subtitle/audio track support
  - Can transcode media when syncing if needed
  - Allows selecting the desired audio track at download time
  - Burns in subtitles not supported at download time
  - Downloads metadata, trickplay, and subtitle tracks
  - Can deal with inconsistent subtitle/audio tracks at download time
- Search the local offline library.
- Can work against an unmodified jellyfin-web by replacing two files and adding a folder.
  - To use without patching jellyfin-web, go to the Offline Sync plugin on the Dashboard of the "Offline Library" server.
  - Optional patch adds "Manage Downloads" to user menu and "Sync Offline" to item menus.
- Developed using AI.

## How it works

In short, this repo adds a service worker to jellyfin-web that simulates an entire Jellyfin server and
also caches the jellyfin-web app offline so it will work in airplane mode. The management UI is all
separate from jellyfin-web and works as a fake server plugin page and also can be accessed via two
very [minimal patches](https://github.com/iwalton3/jf-offline/blob/main/patches/0001-offline-sync-entry-points.patch)
to jellyfin-web to make it less annoying to use. This was developed using Claude, the part that made it practical was
that I already had an automatically generated [test library and QA server](https://github.com/iwalton3/stdjflib)
Claude could rapidly build against.

Reader note: The rest of this document was authored by Claude if you are interested in the details.

A service worker impersonates a Jellyfin server well enough that an
**unmodified, unrecompiled jellyfin-web** browses and plays a library held
entirely in the browser. Downloads are pulled from the real servers you are
signed in to, stored in the origin private file system, and served back over
ranged HTTP the app cannot tell from a server on the network.

```
┌─ your browser ──────────────────────────────────────────────────────┐
│                                                                     │
│   jellyfin-web ──── /Items, /PlaybackInfo, /Videos ───►  service    │
│   (stock build) ◄── JSON, and media as ranged 206s ────  worker     │
│                                                            │        │
│                                                      reads │        │
│                                                            ▼        │
│   download manager ──────────── writes ──────────► IndexedDB (meta) │
│   (vdx-web, in the page)                           OPFS  (the bytes)│
│            │                                                        │
└────────────┼────────────────────────────────────────────────────────┘
             │ HTTPS, with your own Jellyfin login
             ▼
     your real Jellyfin server(s)
```

**No patch to jellyfin-web is required**, and that is the point of the design:
the overlay meets the app at seams it already has, so it does not have to follow
jellyfin-web's churn. The app finds the phantom server by probing its own origin,
registers the worker itself, and loads the download manager the same way it loads
any plugin's settings page. Everything works against a build straight off
jellyfin-web's own release branch.

There is [one optional
patch](https://github.com/iwalton3/jf-offline/blob/main/patches/0001-offline-sync-entry-points.patch),
which the demo applies: thirty-seven lines that add **Manage Downloads** to the
user menu and **Sync Offline** to item context menus, each guarded on the overlay
being present. Without it the manager is still reachable through Dashboard →
Offline Sync, and every other feature is unchanged.

## The demo

<https://iwalton3.github.io/jf-offline/> — built and deployed by
`.github/workflows/pages.yml` on every push, from jellyfin-web's own source plus
this overlay. Nothing is committed pre-built.

A Pages project site lives in a subdirectory rather than on its own host, so the
whole thing runs under a base path: the worker derives it from its registration
scope, and `tools/build-site.py` writes the three things `serve.py` normally does
at request time into files, because a static host cannot do them. CI serves the
assembled site from a plain static host and drives it in a browser
(`tools/verify-site.js`) before deploying, since "the files are present" and "the
app boots and finds its server" are different claims.

The same job packages the tree a second time at an origin root and uploads it as
`jf-offline-bundle.zip`, which is what the self-hosting link above points at.

## Running it locally

```sh
# once: build jellyfin-web (any recent checkout)
cd ~/Desktop/jellyfin-web && npm run build:production

# then
python3 serve.py                      # http://127.0.0.1:8099/web/
```

Then follow *Using it* above. On an unpatched build the manager is at
Dashboard → Offline Sync rather than in the menus.

## The whole change to jellyfin-web

Two files in the built output, neither of them application code:

| file | change |
|---|---|
| `dist/serviceworker.js` | replaced with the phantom server |
| `dist/config.json` | `multiserver` set to `true` |

`serve.py` does not copy them over the build. It serves `overlay/` in front of
`dist/`, so the overlay directory **is** the diff.

### Subtitles keep their format

ASS and SSA are stored as themselves and rendered by jellyfin-web's libass, with
the fonts embedded in the container downloaded alongside. That matters for
anything typeset rather than merely captioned: a styled track survives even when
the video had to be transcoded, so it does not have to be burned in. Only
picture-based tracks have nothing to extract, and those are the only case where
the settings page asks a question.

### Offline, properly

The app itself is held offline, not just the media. jellyfin-web is two thousand
lazily-loaded chunks, so caching on demand leaves every route nobody visited
broken in airplane mode, and there is no way to know in advance which those are.
The host publishes `/web/precache-manifest.json` (a build artifact in a real
deployment) and the worker holds the lot — about 55 MB — resumably in the
background, because a worker doing that many fetches will be killed part-way. The
settings page shows the progress.

### An optional jellyfin-web patch

To see the entry points locally, patch a checkout and point the dev host at its
build. `tools/patch-web.sh` applies and reverts them and reports whether a
checkout is patched:

```sh
git worktree add /tmp/jfweb-12 origin/release-12.z   # or use your own checkout
tools/patch-web.sh apply /tmp/jfweb-12
(cd /tmp/jfweb-12 && npm ci && npm run build:production)
python3 serve.py --webroot /tmp/jfweb-12/dist
```

`serve.py --webroot` takes any build, so a patched and a stock one can sit side
by side and the suite can be run against either. It is worth running against
both: the suite reports the patch's absence rather than failing on it, so only a
patched build exercises the menu entry.


`patches/` adds two entry points to jellyfin-web: **Manage Downloads** in the user
menu and **Sync Offline** in an item's context menu, each opening the manager in a
near-full-page modal. Thirty-seven lines across two files, and every entry is
guarded on `window.__phantom?.ui`, so a build without the patch is unaffected and
the manager stays reachable through its Offline Sync settings page. CI warns and
carries on if a patch no longer applies. Verified against `release-12.z`, which
is the branch CI builds.

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

## Updating

The site auto-updates: the app asks for a worker update on every load, and a
change to anything the worker imports is detected. **It applies on the load
after the one that finds it** — the first installs the new worker, the next runs
it — so a restart picks up a deploy. The settings page says when an update is
waiting rather than leaving it to folklore. `tools/check-update.js` measures the
behaviour against a running dev host.

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
