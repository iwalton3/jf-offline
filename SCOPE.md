# v0 scope

## The contract

What settles a disagreement about this project, stated by the owner: **conformance
to the Jellyfin API, coherent technical design of the internals, and the UI
contract already agreed.** Everything else is malleable. A rule that cannot name
which of those three settles it is not ready to be applied.

Answers the owner has given, so nothing has to be re-derived from the code that
would be judged by them:

- **The storage figure accounts for every byte on disk.** "Downloads are using X"
  on the settings page means all of it — media, subtitles, embedded fonts,
  trickplay tiles and artwork, including a series' and a season's artwork, which
  belongs to no row in the list. A figure that counts the media transfer alone is
  wrong even when deletion is perfect.
- **A second question is refused, structurally.** While one download question is
  being inspected or confirmed, the control that starts another is disabled
  rather than left live to be ignored. Refusing in the handler and leaving the
  picker pressable is the shape that produced a silent no-op.
- **A cancelled download leaves nothing a later read can see**, wherever in the
  download the cancel landed. This is the promise; "never recorded COMPLETE" was
  a narrower one that the code stopped keeping. `CLAUDE.md` carries the long
  version and the supersession.
- **The database keeps its version bump, and a stranded tab is told why.** The
  bump that indexed two hot-path lookups stays. What it cost was that a build
  which cannot open the store had nothing to say about it, and a person met the
  browser's own error page instead. Both version disagreements now carry a
  sentence they can act on. `docs/the-store.md` has the shape, including the one
  upgrade this cannot help.

## What a UserDataChanged push contains

Measured against a real Jellyfin 12.0.0 with `tools/userdata-probe.py`, not read
out of jellyfin-web. Marking one episode of a multi-episode series played:

| entry | what it carried |
| --- | --- |
| the episode | `Played`, `PlayCount`, `PlaybackPositionTicks`, `IsFavorite`, `LastPlayedDate` |
| one ancestor | `Played` false, `PlayCount` 0, `PlaybackPositionTicks` 0, `IsFavorite`, `PlayedPercentage`, `UnplayedItemCount` |

Read: **an ancestor's entry is counted over its own children and carries nothing
of the child's.** No `LastPlayedDate` on the ancestor, and its `PlayedPercentage`
is a fraction of episodes rather than a position in a file — 12.5 for one of
eight, where an episode's own percentage is a position over a runtime.

Which ancestor the server picks is the item's own parent in the database, which
is not always the one an episode's DTO names: a show with season folders gets a
`Season` entry, and a flat show whose season is virtual gets a `Series` entry.
**The phantom deliberately pushes every ancestor it holds instead of one**, both
season and series, because it has no other way to refresh a Series card and
jellyfin-web applies each entry only to the card whose `data-id` matches it.
Each entry still has to describe the item it names.

`api_key` in the query string is refused on `/socket` with a 403, the same way
12.0.0 refuses it on `/Items/{id}/Download` and the HLS playlist endpoints. The
token has to travel in the `Authorization` header.

## In

- **Respecting the source server's permissions.** An account without Jellyfin's
  content-downloading permission is refused, and one without transcoding
  permission may still take originals but not anything needing re-encoding.
  Enforced in the downloader, where the requests are issued, not only in the UI.

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
- **Arbitrating tracks per episode.** A show whose episodes disagree about track
  numbering or naming opens a grid: one row per episode, audio and subtitle
  pickers, with bulk rules (subbed, dubbed, first track, second track, none) that
  apply across the set and leave the episodes they do not fit highlighted for the
  person to fix. The rules are ported from jellyfin-mpv-shim, weights and all.
- **Picking part of a series**: a single season, or only the episodes not yet
  watched, read from the source server's own watched state.
- **Trickplay** scrubbing thumbnails, confirmed working against a server that has
  them generated.
- **Cancelling a download in flight**, which discards the partial file rather than
  leaving something that looks held.
- **Transcode quality**, chosen at sync time and defaulting to 720p, with a
  warning before the fact: a download asks somebody else's server to re-encode,
  once per episode.
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

- Switching audio track or re-picking burned-in subtitles after download. Both are
  fixed at sync time by what the browser can do, and changing either means
  downloading the item again.
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

## Known non-issues

`hls.js` logs a non-fatal `internalException` for `demuxerWorker` in headless
Chrome. A real Jellyfin server produces the same error on the same item;
`tools/dbg-hls-baseline.js` is that comparison. Playback is unaffected.

`ERR_ABORTED` on `/Sessions/*` requests in a trace is the browser cancelling
in-flight requests at navigation. The smoke test checks the journal after real
playback to confirm the app's own reports land.
