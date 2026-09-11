# v0 scope

## In

- The phantom server appears as its own server in jellyfin-web, alongside the real
  ones. Sign in as **Offline**, no password.
- Home, main browse, series and season detail pages.
- Downloading movies and whole series from any server jellyfin-web is signed in to.
- Two download modes, chosen from what this browser can actually play:
  **direct** stores the original file, **hls** stores a server-side transcode as a
  complete VOD stream.
- Playback of both, through jellyfin-web's own player, with the network off.
- Play state tracked locally, and pushed into open grids over the socket stand-in.
- Primary, thumb, logo and one backdrop image per item.
- **Subtitles, in the format they were authored in.** ASS and SSA are kept as
  themselves and rendered by jellyfin-web's libass, with the fonts embedded in the
  container downloaded alongside, so styled and typeset subtitles survive even
  when the video itself had to be transcoded. Other text tracks become WebVTT
  sidecars. Only picture-based tracks (PGS, VobSub, DVB) have nothing to extract,
  and for those the settings page asks at sync time whether to burn one in — which
  forces a transcode and fixes the choice for good, and is therefore a decision
  only the person downloading can make.
- **The whole web client held offline**, so airplane mode reaches routes that were
  never visited, the download manager included.
- **Search** over the held library, ranked by where the match falls, plus the
  type-ahead hints the search screen draws first.
- **Dual audio.** A browser plays whichever track the container defaults to and
  cannot switch, so the settings page asks at sync time; choosing another track
  transcodes with it selected.
- **Default track selection transfers**, taken from the source server rather than
  guessed, and never naming a track that was not downloaded.

## Out, deliberately

- **Syncing play state back to the source servers.** The journal records every
  outbound operation and nothing drains it. Adding syncback is a drain loop, not a
  migration.
- **Search, filtering, genres, studios, collections, similar items.** These answer
  with well-formed empties. An empty list renders; an error does not.
- **iOS and Safari.** Not tested, not targeted.
- **Auto-download, retention, size caps, the reaper.** `origin` is written on every
  download row so the reaper has something to respect when it exists.
- **Background Fetch**, so downloads need the Offline Sync page open.
- **Resuming a partial download** across a reload. A failed write is discarded
  rather than left truncated, so a retry starts clean.
- Music, books, photos, live TV.
- Filtering by genre, year or rating. Search matches names only.
- Chapter images.
- Multiple versions of one item. The downloader picks the best single source.

## Fixed since the first build, and why they were invisible

- **Downloading from the settings page failed to store anything.** IndexedDB
  refuses to clone a Proxy and vdx holds list state in one. Every test drove the
  downloader with a plain fetched object, so the path the UI actually uses was
  the one path never exercised. The downloader now converts at its own entry.
- **The first visit found no server.** jellyfin-web probes for a server during
  boot and registers the worker afterwards, so nothing answered the probe and the
  app settled on "no servers" with nothing to retry. The host answers
  `/System/Info/Public` now. It looked Firefox-specific only because the test
  suite reloaded the page and a person on Chrome had reloaded too.
- **Edits to overlay files did not take.** The worker cached them first, which is
  only safe for URLs that pin their content by hash. jellyfin-web's bundles do;
  ours do not.
- **The download manager stopped at 200 items.** It now pages, and the suite
  checks it against a library of a thousand.
- **Persistent storage was never requested**, so the browser was free to evict
  the library. Asked for on the download gesture, which is the only time Firefox
  will grant it, and shown in the settings page.

## Implemented but unverified

**Trickplay** tiles are downloaded and served, and nothing exercises that path:
the QA library has no trickplay generated, so there was nothing to download. It
is written to fail quietly rather than to be trusted.

## Known non-issues

`hls.js` logs a non-fatal `internalException` for `demuxerWorker` in headless
Chrome. A real Jellyfin server produces the same error on the same item;
`tools/dbg-hls-baseline.js` is that comparison. Playback is unaffected.

`ERR_ABORTED` on `/Sessions/*` requests in a trace is the browser cancelling
in-flight requests at navigation. The smoke test checks the journal after real
playback to confirm the app's own reports land.
