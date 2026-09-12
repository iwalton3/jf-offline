# The store

Two stores hold everything the phantom server serves. IndexedDB holds the rows —
what exists, what it belongs to, and what has been watched. OPFS holds the bytes
— media, sidecars, tiles and artwork. `overlay/ps/schema.js` is the single
definition of both, loaded as a classic script in the worker and in the page, so
neither context has to remember a key shape.

## Rows

| store | key | holds |
| --- | --- | --- |
| `meta` | `name` | worker-scoped values, notably the live precache pointer |
| `servers` | `id` | **declared, never read or written** — see below |
| `items` | `[srv, id]` | one row per item, the stored DTO on `dto` |
| `downloads` | `[srv, itemId, sourceId]` | one row per copy on disk |
| `userdata` | `[srv, itemId]` | played state, position, favourite |
| `journal` | `seq`, auto | every outbound operation, written and never drained |

Which source servers exist is not one of these. The downloader reads
jellyfin-web's own `jellyfin_credentials` in `localStorage`, so the app and the
phantom cannot disagree about who is signed in; the `servers` store is an empty
affordance, like the journal, and nothing in v0 puts a row in it.

`items` is keyed by server as well as id because the same item id can be held
from two servers. `downloads` is keyed by media source as well, so a second
version of one item can be held later without a migration — that is a schema
affordance, not a v0 feature, and `SCOPE.md` puts multiple versions out of
scope.

Indexes exist only where the worker looks something up on a hot path: once per
poster while a grid draws, once per segment during playback. `by_id` on `items`
and `by_item_id` on `downloads` are the two that arrive from jellyfin-web
knowing an item id and nothing else.

## Bytes

Everything lives under a single OPFS root, `phantom`, so a wipe is one
`removeEntry`. Two trees hang off it, and the split is the important part:

    media/<srv>/<itemId>/<sourceId>/original.<container>
                                   /hls/main.m3u8, <n>.ts
                                   /subs/<index>.<format>
                                   /attachments/<index>
                                   /trickplay/<width>/<n>.jpg
    images/<srv>/<itemId>/<type>

**Media hangs off a media source; artwork hangs off the item.** A multi-version
item has one poster, so artwork cannot live inside a source's directory —
removing that source would strand it in a tree nothing walks. `imageDir` exists
to give it a directory of its own.

Subtitle extensions are the track's real format, not always `vtt`. Image type
segments are lower-cased, because the router matches on a lower-cased path and
hands handlers a lower-cased capture while the downloader writes with Jellyfin's
own capitalisation.

## Three lifetimes

Bytes and rows are reclaimable when the thing that wrote them stops being held,
and "the thing" is not the same thing three times over:

1. **A copy.** Media, sidecars and tiles, keyed `(srv, itemId, sourceId)`. They
   go when that download goes.
2. **An item.** Its row and its artwork, keyed `(srv, itemId)`. They live while
   any download of that item survives, so removing one of two sources must not
   take them.
3. **A parent.** A Series or Season row and its artwork, which have **no
   download row at all**. Their lifetime is descendant reachability: a parent is
   held while some held episode still names it.

`reclaimUnreachable()` recomputes all three from the download rows rather than
unwinding whatever the caller did, so it is right however the rows went away — a
failed download, a cancel, a season filter that took nothing — and not only on
the path somebody remembered to clean up. This is the same derive-don't-prune
rule the library reads by; `CLAUDE.md` carries it.

Parent **rows** are deliberately left in place while their artwork is reclaimed.
The library presents a parent only while an episode still references it, so a
stranded row is invisible, and keeping it means a later download of another
episode does not have to refetch the hierarchy.

User data is deleted only when the last copy of an item goes, and only on a
deliberate removal. Removing one of two sources is not a decision to forget that
something was watched.

## The figure the settings page shows

`SCOPE.md` says the storage figure accounts for **every byte on disk** — media,
subtitles, embedded fonts, trickplay tiles and artwork, including a series' and
a season's artwork, which belongs to no row in the list.

So `storageUsed()` walks the store and groups by path prefix. It does not sum
`bytesDone`, which records the media transfer and nothing else: everything
written after the transfer leaves it untouched. On the smoke fixture that gap
was 24% of the store, invisible to the page and to every row in the list.
`navigator.storage.estimate().usage` is not used either — measured at 0.5 GB
against 4.4 GB actually written.

## Versions

The database version is in `schema.js` and upgrades are **additive only**: a
database this build touches must still open in the build before it. Nothing in
`onupgradeneeded` may drop or rewrite a store.

A connection lets go when another asks to upgrade. Without a `versionchange`
handler, a tab running the previous build holds the old version open and the new
build's `open()` never completes — it does not fail, it waits, so the app simply
never finishes starting and nothing says why. The handler closes the connection
**and forgets the memo**, because `PS_SCHEMA.once()` caches a success: leaving
it would hand a closed database to every later transaction in that context.

Two disagreements between a build and a stored database are possible, and
`ps/db.js` owns the sentence shown for each:

- **blocked** — this build wants a higher version and another tab has not let
  go. The person closes the other tabs.
- **obsolete** — the store has been upgraded by a newer build and this one is
  pinned lower, which arrives as a `VersionError`. The person reloads.

Both are reported rather than thrown. The app shell reads the live cache pointer
out of `meta`, so an unopenable store takes every page down and not merely the
ones that need the library; before this was handled, a navigation ended as the
browser's own error page with nothing of the app's on it.

**The release handler cannot help the upgrade that introduces it.** The
connection that has to let go belongs to the build being replaced, which does
not have the handler. The first bump after a deploy is therefore the one that
can still strand a stale tab, and what that tab sees is the message above.
