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
- **`document.createElement` is patched.** jellyfin-web bundles the webcomponents
  ES5 shim, which builds elements its own way and never upgrades a custom element
  made through it. Create custom elements through the parser (`innerHTML`) or the
  native constructor, or the component mounts and silently never renders.
- **IndexedDB refuses to clone a Proxy.** See the ground rules above. The
  downloader converts at its own entry points; keep it that way rather than
  adding a conversion per store call.
- **Cache-first is only safe for a URL that pins its content.** jellyfin-web's
  bundles carry a content hash; the overlay's files do not. Caching ours first
  serves last session's module forever, and the symptom is an import failing for
  an export plainly present in the file on disk.
- **Query parameter case is not consistent.** The same screen sends both
  `IncludeItemTypes` and `includeItemTypes`. Read them through `PS_HTTP.Params`.
- **A worker cannot intercept a WebSocket.** No hook exists, and jellyfin-web will
  open one, because every item grid subscribes to `UserDataChanged` on mount
  (`emby-itemscontainer.js:294`). `ps-bootstrap.js` stands in for it.
- **Auth to a real server goes in the `Authorization` header.** On 12.0 the
  `api_key` query parameter is refused by `/Items/{id}/Download` and by the HLS
  playlist endpoints, which are exactly the two a download needs.
- **vdx refuses to bind a component method that collides with a DOM method.**
  `remove` is the one you will reach for.

## The schema is shaped for features that do not exist yet

`overlay/ps/schema.js` is the single definition, loaded in both the worker and the
page. Three decisions there are load-bearing and should not be "simplified":

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
