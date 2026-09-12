# CLAUDE.md

Guidance for working in this repository.

## What this is

A service worker that impersonates a Jellyfin server so an **unmodified,
unrecompiled jellyfin-web** browses and plays media held in the browser.
`README.md` is the orientation; `SCOPE.md` says what v0 deliberately omits.

## Ground rules

**Do not modify jellyfin-web.** The whole point is integrating at its seams. The
only permitted changes are the two files in `overlay/` that shadow its build
output, plus the two things `serve.py` does before the worker exists. If a change
seems to require touching jellyfin-web source, that is a finding worth reporting,
not a step to take quietly.

**Observe the API, do not read it out of jellyfin-web.** `tools/probe-requests.js`
drives a real browser against a real server and records which endpoints each
screen asks for, with their parameters. Every endpoint in `ps/router.js` came from
that. Reading the app's source to guess the shape is how you get a handler that
works on one screen and mysteriously does not on the next.

**Test through the UI, not around it.** The worst defect in this repo's history
stored nothing at all when you pressed Download, while every test passed: the
tests called the downloader with a plain fetched object, and the settings page
hands it a vdx reactive Proxy, which IndexedDB refuses to clone. If a check can
drive the component's own methods, it should.

**`tools/smoke.js` is the suite.** It runs in a real browser because nothing here
can be exercised in node. Add to it rather than writing a second harness.

```sh
python3 serve.py &                  # needs a real Jellyfin on :8096
NODE_PATH=/working/mrepo-web/tests/node_modules node tools/smoke.js
HEADFUL=1 ... node tools/smoke.js   # to watch it
```

## Things that have already cost a day

- **`overlay/serviceworker.js` is also loaded as an ordinary page script.**
  jellyfin-web's build lists the serviceworker chunk in HtmlWebpackPlugin's
  `chunks` (`webpack.common.js:74`), so `index.html` carries a
  `<script defer src="serviceworker.js">`. Upstream that is inert. Anything that
  only exists in a worker must sit behind `IS_SERVICE_WORKER`.
- **IndexedDB refuses to clone a Proxy.** See the ground rules above. The
  downloader converts at its own entry points; keep it that way rather than
  adding a conversion per store call.
- **Cache-first is only safe for a URL that pins its content.** jellyfin-web's
  bundles carry a content hash; the overlay's files do not. Caching ours first
  serves last session's module forever, and the symptom is an import failing for
  an export plainly present in the file on disk.
- **Query parameters are inconsistent in two ways, and both bite.** Case varies
  (`IncludeItemTypes` beside `includeItemTypes`), and list values arrive
  **repeated** — `includeItemTypes=Movie&includeItemTypes=Series&…` — as well as
  comma-separated elsewhere. Reading only the last value made the search screen
  ask for a dozen types and receive a filter of one, so every section but the
  first looked empty. Always read through `PS_HTTP.Params`.
- **The document is served cache-first, everything else network-first.** A cold
  start must not wait on a request, and an offline one must not wait for a
  request to fail — on a phone that is not always prompt, and it was reported as
  the app refusing to open in airplane mode with everything held. The cost is
  that a new build's document lands one load later, which is exactly how a worker
  update already behaves.
- **Offline-ready is the cache POINTER, not a file count.** `precacheStatus`
  reports `ready` only when the live pointer names a complete cache; claiming
  completeness from `done >= total` is how the page could say the client was held
  offline while still being served from the previous cache.
- **Never empty the live cache.** Fill a new versioned cache, swap the stored
  pointer, then delete the old one. Deleting first left tens of seconds with
  nothing cached, and writes issued in that window went into a deleted cache and
  vanished — an app that stopped working intermittently, always just after an
  update.
- **Never let the source server choose what to burn in.** Ask for a transcode
  without naming `SubtitleStreamIndex` and Jellyfin falls back to the user's own
  default track, which for Japanese audio is often picture-based signs and songs —
  encoded into the video permanently, with nobody asked. Pass `-1` unless a track
  was deliberately chosen.
- **Report only what can actually be played.** Passing the source's full stream
  list through gave the app an audio track selector where every entry but one did
  nothing: a transcode holds one track, and a browser cannot switch tracks in a
  downloaded original either.
- **A vdx getter is a computed cell, and chaining one into another breaks.** It
  surfaced as `rows is not iterable` from inside a reactive effect. Use plain
  methods for anything a template composes.
- **A row inside `cl-virtual-list` may read nothing but its own item.** Rows are
  memoised by key, so a row drawn while the component was busy keeps that
  appearance for good. This is how every download button ended up greyed out
  after a filter.
- **A worker cannot intercept a WebSocket.** No hook exists, and jellyfin-web will
  open one, because every item grid subscribes to `UserDataChanged` on mount
  (`emby-itemscontainer.js:294`). `ps-bootstrap.js` stands in for it.
- **Auth to a real server goes in the `Authorization` header.** On 12.0 the
  `api_key` query parameter is refused by `/Items/{id}/Download` and by the HLS
  playlist endpoints, which are exactly the two a download needs.
- **vdx refuses to bind a component method that collides with a DOM method.**
  `remove` is the one you will reach for.
- **`document.createElement` does not upgrade custom elements.** jellyfin-web
  loads webcomponents.js 0.7 for its own `emby-*` elements, and that replaces
  `createElement`; an element made through the replacement runs its
  connectedCallback against a bare HTMLElement and throws before it renders.
  Measured in the page: the parser (`innerHTML`), `importNode` and the native
  `createElement` all upgrade correctly, and only the patched one does not.
  `tools/sync-vdx.sh` rewrites that call in the copied vdx sources, so **do not
  edit anything under `overlay/plugin/vdx/` by hand** — re-run the script. Create
  your own custom elements through the parser.
- **The router matches on a lower-cased path.** Handlers get lower-cased captures.
  This cost a day once already: image files were written as `Primary` and read as
  `primary`, and every image 404'd with nothing anywhere saying why.

- **Do not "normalise" subtitles to WebVTT.** ASS and SSA are stored and served
  as themselves, because `htmlVideoPlayer` routes a track to libass on its
  reported `Codec` and converting discards the positioning and typesetting that
  is the entire point of those formats. libass also needs the container's font
  attachments and a working `GET /System/Configuration/encoding`: that call is
  awaited before the renderer starts, so a 404 there means an ASS track silently
  never appears.

- **`navigator.storage.estimate()` does not report a real quota.** Chromium
  answers roughly what you are using plus a constant, to make it useless for
  fingerprinting, so a "GB available" reading moves as you download and says
  nothing about the disk. The settings page shows used space and no percentage.
- **A `fetch()` from inside the worker is a real network request** and is not
  intercepted by that worker. Anything the worker reads to serve a response has to
  fall back to the cache, or it becomes the one page that fails offline.

- **The library is what is HELD, derived, not pruned.** A Series or Season row is
  written so an episode has a parent and outlives its children, so `loadAll`
  presents one only while an episode still references it. Doing this at read time
  rather than as a cleanup on delete means it is right however the rows went away
  — a failed download, a cancel, a season filter that took nothing — and not only
  on the path somebody remembered to clean up. Counts are recomputed for the same
  reason: a show page saying "24 episodes" over the three that are here is worse
  than no number.
- **A subtitle track index is per file and a show is not required to be
  consistent.** English can be index 2 in one episode and 4 in the next. A
  series-wide choice therefore travels as what the track IS — language, codec,
  forced, title — and is resolved against each file by `matchTrack`, which
  declines when two candidates are indistinguishable rather than guessing. Burning
  "index 2" across a season burns whatever happens to be second, which for anime is
  routinely signs and songs. Declining is not the end of it: a show that cannot be
  resolved automatically must still be downloadable, so the grid and the bulk
  rules in `bulkSelect` exist to let a person settle it. The weights in
  `dialogueWeight` and `signWeight` are ported from jellyfin-mpv-shim's
  `bulk_subtitle.py` and encode real release-group naming; do not "tidy" them.
- **A fixed-height scroll container swallows the wheel when it has nothing to
  scroll.** Use `max-height`. And an infinite-scroll handler must check that the
  element can scroll at all, or a list shorter than its box reports zero remaining
  on every wheel event and asks for the next page each time.

- **The download question has one definition, `askDefaults()`, used to seed the
  component AND to clear it.** A field added there is automatically initialised
  and reset. Keeping a separate list of things to clear is exactly how a
  cancelled series left its sixty-episode grid, its seasons and its tracks
  sitting in front of the next one. Anything that is a *result* rather than part
  of the question — the per-episode notes — lives outside it on purpose.

- **A download is not a read, and the server says who may make one.**
  `EnableContentDownloading` gates any download and
  `EnableVideoPlaybackTranscoding` gates one that needs re-encoding; Jellyfin
  grants them separately because they cost the server differently. Enforced in
  `assertAllowed`, called from the downloader rather than from the UI, because
  the UI is a suggestion and the downloader is what issues requests.

- **The page is NOT controlled by the worker on its first visit.** Anything the
  UI needs immediately must therefore be a real file the host serves, not a URL
  the worker synthesises. The download manager lives at
  `overlay/plugin/manager.js` for exactly this reason; jellyfin-web's plugin page
  reaches it through a one-line re-export the worker generates, because
  jellyfin-web insists on loading a controller from `configurationpage?name=…`.
- **Deployment may be in a subdirectory.** GitHub Pages project sites are.
  `PS_SCHEMA.basePath` is derived (from the worker's registration scope, or the
  page's own location) and the router strips it before matching, so routes stay
  written as if mounted at the root. Module specifiers are relative for the same
  reason — an absolute `/web/...` only resolves at an origin root.
- **`navigator.storage.estimate().usage` lags badly**, measured at 0.5 GB against
  4.4 GB actually written. The settings page sums the download rows instead,
  which is the number the list adds up to.

- **A worker update applies on the load AFTER the one that finds it.** Changing a
  file the worker imports is detected — Chrome re-fetches imported scripts and
  byte-compares them — and a new worker installs and then waits. `skipWaiting()`
  does not promote it here, from the install handler or from a message, even
  though the waiting worker demonstrably receives messages and replies. The next
  navigation promotes it, because the page being replaced leaves no clients.
  `tools/check-update.js` measures this; `ps-bootstrap.js` calls `update()` on
  load so the check happens promptly, which is the difference between "next
  start" and "eventually", and surfaces a waiting update so the page can say so.

- **PlaybackInfo cannot tell you whether a download is a remux or a re-encode,
  and both its answers say "transcode".** `SupportsDirectStream` is false for
  every container the device profile does not list, and `TranscodeReasons` is
  absent from the MediaSource entirely — it lives only in the `TranscodingUrl`
  query, where it reads `ContainerNotSupported,AudioCodecNotSupported` even for
  a file whose audio the profile does carry. Measured instead: a source whose
  video codec the transcoding profile already targets is STREAM-COPIED at full
  resolution. `hlsPlan()` is that rule and `tools/remux-probe.py` is the
  measurement; re-run it against a new server version rather than reasoning
  about it.
- **Never send a quality cap on a rendition the server would copy.** The cap is
  what creates the encode it was meant to bound: an h264 mkv at 1920x804 arrives
  untouched with no cap and at 1718x720, a third of the size, with `MaxHeight`
  attached. So the cap follows `hlsPlan().videoCopy`, the question is only asked
  when an encode is happening anyway, and a remux does not stop to ask at all.
- **Only a series or a season may be removed in bulk.** Films are listed flat.
  Grouping them put a "Remove group" button over the whole catalogue, wearing the
  same control that removes one season of one show — reported as "deleting the
  movies group deletes the entire catalog". A group earns its delete by being
  something a person already thinks of as one thing.

- **`exclusive()` is for the download, not for the question.** `start()` inspects
  an item and may end by calling `run()`, which takes the lock — holding it across
  the inspection meant `run()` was refused and the download silently never began,
  for every item with nothing to ask about. Checking uses `task()`.
- **The modal is defended by hand, not by a shadow root.** A shadow root is the
  obvious isolation for a panel dropped into someone else's document, and it was
  tried and reverted: vdx-web's styling reaches the component from the document
  and a boundary around it breaks that. The manager is its own shadow-DOM
  component anyway, so only the chrome in `ps-ui.js` is exposed — every layout
  property there is `!important`, every chrome element is reset rather than
  assumed, the root sets `font` so `em` is ours, and the panel sizes in
  percentages rather than `vw`/`vh`. A check in `tools/smoke.js` drops a hostile
  stylesheet on the page and measures the close button: against chrome that only
  styles itself it lands hundreds of pixels outside a phone-width panel. That is
  the test, because the phone report itself does not reproduce in puppeteer.

## The schema is shaped for features that do not exist yet

`overlay/ps/schema.js` is the single definition, loaded in both the worker and the
page. Four decisions there are load-bearing and should not be "simplified":

- **Source item ids are never reminted.** Rows carry the source `serverId`
  alongside, so syncback and re-download stay lookups.
- **The journal is written and never drained.** Adding syncback is then a drain
  loop, not a migration over history nobody recorded.
- **`playedSetBy` distinguishes a progress report from a deliberate mark.**
  Progress is a floor that may only advance; a mark played or unplayed is
  authoritative in both directions. Nothing in v0 consumes the distinction, but it
  cannot be recovered after the rows are written.
- **`origin` is never null.** Always `'user'`. A nullable origin meeting
  three-valued logic is how a future reaper becomes eligible to delete the things
  a person asked for.

## Layout

Files are listed in `README.md`. The short version: `overlay/ps/` is the worker,
`overlay/plugin/` is the download manager UI in vdx-web, `serve.py` is the dev
host, and `overlay/` as a whole is the diff against an unmodified jellyfin-web
build.
