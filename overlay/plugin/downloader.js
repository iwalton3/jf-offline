/* The download engine.
 *
 * Runs in the page, not in the service worker. A service worker is killed after a
 * short idle period, so a download loop living in one dies part-way through a
 * file; the page stays alive as long as it is open. The cost is that downloads
 * need this page open, which is the v0 trade. Background Fetch is the way out and
 * is Chrome-only, which is no longer a constraint here.
 */

import { deviceProfile } from './source.js';

const S = () => window.PS_SCHEMA;
const DB = () => window.PS_DB;
const OPFS = () => window.PS_OPFS;

/**
 * A plain, storable copy of a DTO.
 *
 * IndexedDB stores by structured clone, which REFUSES a Proxy. vdx holds
 * component state in reactive proxies, so an item picked out of the settings
 * page's list is a Proxy and every write of it fails with "could not be cloned"
 * — while the same item fetched directly stores fine, which is why a test that
 * does not go through the UI will never see this.
 *
 * Applied at this module's entry points rather than at each store call, so the
 * rule is "nothing reactive gets past the downloader's front door" and there is
 * one place to check rather than four. Safe because every value here came off the
 * wire as JSON in the first place.
 */
const plain = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/**
 * Downloads that can still be stopped, by the key their row is stored under.
 *
 * A cancel has to reach the fetch that is in flight — a several-gigabyte file or
 * a long run of segments will not notice a flag between iterations — so each
 * download carries an AbortController and the map is how the UI finds it.
 */
const inFlight = new Map();

const downloadKey = (srv, itemId, sourceId) => [srv, itemId, sourceId].join('|');

/** Stop a running download. Partial files are discarded, not left to look held. */
export async function cancelDownload(srv, itemId, sourceId) {
    const entry = inFlight.get(downloadKey(srv, itemId, sourceId));
    if (!entry) return false;
    entry.cancelled = true;
    entry.controller.abort();
    return true;
}

/** Stop everything, including the rest of a series that has not started yet. */
export function cancelAll() {
    for (const entry of inFlight.values()) {
        entry.cancelled = true;
        entry.controller.abort();
    }
    seriesCancelled = true;
    return inFlight.size;
}

let seriesCancelled = false;

export const isCancelled = (srv, itemId, sourceId) => {
    const entry = inFlight.get(downloadKey(srv, itemId, sourceId));
    return !!(entry && entry.cancelled);
};

/**
 * Ask the browser not to evict this origin's storage.
 *
 * Without it everything downloaded is "best effort" and the browser may clear it
 * whenever it wants the space — which for an offline library means it is gone on
 * exactly the trip it was downloaded for.
 *
 * Call it from a click handler. Chrome decides from its own engagement
 * heuristics and never prompts; Firefox prompts, and only honours the request
 * while a user gesture is being handled.
 */
export async function ensurePersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
        return { supported: false, persisted: false };
    }
    if (await navigator.storage.persisted()) return { supported: true, persisted: true };
    try {
        return { supported: true, persisted: await navigator.storage.persist() };
    } catch (err) {
        return { supported: true, persisted: false, error: String(err.message || err) };
    }
}

/**
 * Refuse a download the server's own permissions would refuse.
 *
 * Enforced here rather than only in the UI, because the UI is a suggestion and
 * this is the thing that actually issues the requests. `transcoding` is checked
 * separately: taking an original file costs a server a read, while taking a
 * transcode costs it an encode per episode, and Jellyfin grants those
 * separately for exactly that reason.
 */
export async function assertAllowed(server, { transcoding } = {}) {
    const policy = await server.policy();
    if (policy.EnableContentDownloading === false) {
        throw new Error('Your account is not allowed to download from this server.');
    }
    if (transcoding && policy.EnableVideoPlaybackTranscoding === false
        && policy.EnablePlaybackRemuxing === false) {
        throw new Error(
            'This item needs transcoding and your account is not allowed to transcode on this server.'
        );
    }
    return policy;
}

/** Containers this browser can hand to a <video> element without a transcode. */
function directPlayable(container) {
    const c = String(container || '').toLowerCase();
    return c === 'mp4' || c === 'm4v' || c === 'webm' || c === 'mov';
}

/**
 * What the server will actually do to produce the HLS rendition.
 *
 * Measured against a 12.0 server, not inferred. A source whose video codec the
 * transcoding profile already targets comes back STREAM-COPIED: an mkv of h264
 * at 1920x804 arrives as h264 at 1920x804, byte-identical whether or not a
 * MaxHeight above its own height was asked for. Only a codec the profile cannot
 * target — hevc, mpeg2, mpeg4 — is genuinely re-encoded.
 *
 * Which is why the quality cap must not be sent by default. Asking a 1920x804
 * copy for MaxHeight=720 turns it into an encode at 1718x720 and a third of the
 * bytes: strictly worse than doing nothing, for a file that needed nothing.
 *
 * `tools/remux-probe.py` is the measurement, and re-running it is how to check
 * this against a different server version.
 */
export function hlsPlan(mediaSource, { burning } = {}) {
    const streams = mediaSource.MediaStreams || [];
    const video = streams.find((st) => st.Type === 'Video');
    const audio = streams.find((st) => st.Type === 'Audio');
    const profile = (deviceProfile().TranscodingProfiles || [])[0] || {};
    const targets = (list) => String(list || '').toLowerCase().split(',').filter(Boolean);
    const codec = (stream) => String((stream && stream.Codec) || '').toLowerCase();

    // Burning is a picture operation: it forces an encode whatever the codec is.
    const videoCopy = !burning && !!video && targets(profile.VideoCodec).includes(codec(video));
    const audioCopy = !!audio && targets(profile.AudioCodec).includes(codec(audio))
        && (audio.Channels || 0) <= Number(profile.MaxAudioChannels || 2);

    return {
        videoCopy,
        audioCopy,
        videoCodec: codec(video) || null,
        audioCodec: codec(audio) || null,
        height: (video && video.Height) || null,
        // A copied video track is a remux however the audio is handled: the
        // picture is untouched, which is the part that cannot be got back.
        remux: videoCopy
    };
}

async function putItem(server, dto) {
    await DB().put('items', {
        srv: server.id,
        id: dto.Id,
        type: dto.Type,
        dto,
        seriesId: dto.SeriesId || null,
        seasonId: dto.SeasonId || null,
        addedAt: Date.now()
    });
}

async function putImages(server, dto, signal) {
    const wanted = [['Primary', dto.ImageTags && dto.ImageTags.Primary]];
    if (dto.ImageTags && dto.ImageTags.Thumb) wanted.push(['Thumb', dto.ImageTags.Thumb]);
    if (dto.ImageTags && dto.ImageTags.Logo) wanted.push(['Logo', dto.ImageTags.Logo]);
    if (dto.BackdropImageTags && dto.BackdropImageTags.length) wanted.push(['Backdrop', dto.BackdropImageTags[0]]);

    for (const [type, tag] of wanted) {
        if (!tag) continue;
        // Outside the try, for the same reason as the other loops here: the catch
        // below swallows a failure so a missing poster does not lose a download,
        // and it would swallow an abort just as happily.
        if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
        try {
            const res = await server.fetchSignal(server.imageUrl(dto.Id, type, tag), signal);
            await OPFS().writeBlob(S().paths.image(server.id, dto.Id, type), await res.blob());
        } catch (err) {
            // An image is not worth failing a download over.
            console.warn('[phantom] image', type, dto.Id, err.message);
        }
    }
}

/**
 * Choose which version of an item to hold.
 *
 * Not simply the first: a multi-version item lists every file it has, and the
 * order is the server's, not a preference. Taking [0] downloads a remux of an
 * mkv when an mp4 of the same episode was sitting two entries later.
 */
function pickMediaSource(sources) {
    const playable = sources.filter((ms) => directPlayable(ms.Container));
    return playable.find((ms) => ms.SupportsDirectPlay || ms.SupportsDirectStream)
        || playable[0]
        || sources.find((ms) => ms.SupportsTranscoding)
        || sources[0]
        || null;
}

/**
 * Subtitle tracks and what can be done with each of them offline.
 *
 * A text track can be extracted to a sidecar the player switches between. An
 * image track (PGS, VobSub, DVB) has no text to extract, so the only way to see
 * it offline is to burn it into the picture — which fixes the choice of track
 * and forces a transcode, and is therefore a decision for the person syncing.
 */
export function subtitleOptions(mediaSource) {
    return (mediaSource.MediaStreams || [])
        .filter((st) => st.Type === 'Subtitle')
        .map((st) => ({
            index: st.Index,
            language: st.Language || 'und',
            title: st.DisplayTitle || st.Title || st.Language || ('Track ' + st.Index),
            codec: st.Codec,
            isForced: !!st.IsForced,
            isDefault: !!st.IsDefault,
            // The whole decision hangs off this flag.
            canExtract: !!st.IsTextSubtitleStream
        }));
}

/**
 * The format to keep a track in.
 *
 * ASS and SSA stay as themselves, because jellyfin-web renders them with libass
 * and converting to WebVTT discards the positioning, styling and typesetting
 * that is the whole reason those formats exist. Everything else becomes WebVTT,
 * which a <track> element can play natively.
 */
function subtitleFormat(codec) {
    const c = String(codec || '').toLowerCase();
    return (c === 'ass' || c === 'ssa') ? c : 'vtt';
}

/**
 * Audio tracks, and whether a choice has to be made about them.
 *
 * A dual-audio file carries both, but a browser will only ever play the one the
 * container defaults to: Chrome does not expose the audioTracks API, so there is
 * no way to switch after the fact. Picking a different track therefore means
 * transcoding with that track selected, which is a decision for sync time.
 */
export function audioOptions(mediaSource) {
    const streams = (mediaSource.MediaStreams || []).filter((st) => st.Type === 'Audio');
    return streams.map((st) => ({
        index: st.Index,
        language: st.Language || 'und',
        title: st.DisplayTitle || st.Title || st.Language || ('Track ' + st.Index),
        codec: st.Codec,
        channels: st.Channels,
        isDefault: !!st.IsDefault,
        isContainerDefault: st.Index === mediaSource.DefaultAudioStreamIndex
    }));
}

/**
 * Find the track a series-wide choice meant, in THIS file.
 *
 * Track indexes are per file and a show is not required to be consistent: the
 * English track can be index 2 in one episode and index 4 in the next, and one
 * episode may not have it at all. Burning in "index 2" across a season therefore
 * burns in whatever happens to be second, which for anime is routinely the signs
 * and songs track rather than the dialogue.
 *
 * So a series choice travels as what the track IS — language, codec, forced flag,
 * title — and is resolved against each file. Returns null when this file has no
 * equivalent, which is a thing to report rather than to guess around.
 */
export function matchTrack(tracks, want) {
    if (!want) return null;
    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const candidates = tracks.filter((t) => !t.canExtract === !want.canExtract);

    const tiers = [
        // Everything agrees, including the title an author gave it.
        (t) => norm(t.language) === norm(want.language) && norm(t.codec) === norm(want.codec)
            && !!t.isForced === !!want.isForced && norm(t.title) === norm(want.title),
        (t) => norm(t.language) === norm(want.language) && norm(t.codec) === norm(want.codec)
            && !!t.isForced === !!want.isForced,
        (t) => norm(t.language) === norm(want.language) && !!t.isForced === !!want.isForced,
        (t) => norm(t.language) === norm(want.language)
    ];
    for (const tier of tiers) {
        const hit = candidates.filter(tier);
        // Only when it is unambiguous. Two English picture tracks and no way to
        // tell them apart is exactly the case a person has to arbitrate.
        if (hit.length === 1) return hit[0];
    }
    return null;
}

async function downloadSubtitles(server, dto, mediaSource, tracks, signal) {
    const held = [];
    for (const track of tracks) {
        // Outside the try: the catch below swallows a failure so one bad track
        // does not lose the rest, and it would swallow an abort just as happily.
        if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const format = subtitleFormat(track.codec);
        try {
            const res = await server.fetchSignal(
                server.subtitleUrl(dto.Id, mediaSource.Id, track.index, format), signal);
            const body = await res.text();
            if (!body.trim()) continue;
            await OPFS().writeBlob(
                S().paths.subtitle(server.id, dto.Id, mediaSource.Id, track.index, format),
                new Blob([body], { type: 'text/plain' })
            );
            held.push({
                index: track.index,
                language: track.language,
                title: track.title,
                codec: track.codec,
                format
            });
        } catch (err) {
            // A track that will not extract is not worth failing the item over.
            console.warn('[phantom] subtitle', track.index, dto.Id, err.message);
        }
    }
    return held;
}

// The mime types htmlVideoPlayer will hand to libass; everything else in a
// container's attachments is cover art and similar, which ffmpeg often cannot
// extract anyway.
const FONT_MIME_TYPES = [
    'application/vnd.ms-opentype',
    'application/x-truetype-font',
    'font/otf',
    'font/ttf',
    'font/woff',
    'font/woff2'
];

/**
 * Fonts an ASS track was authored against.
 *
 * Without them libass substitutes, and the result is wrong in ways that are
 * obvious on typeset anime and invisible on plain dialogue — so it is worth
 * fetching files that can run to tens of megabytes.
 */
async function downloadAttachments(server, dto, mediaSource, signal) {
    const wanted = (mediaSource.MediaAttachments || [])
        .filter((att) => FONT_MIME_TYPES.includes(att.MimeType));

    const held = [];
    for (const att of wanted) {
        if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
        try {
            const res = await server.fetchSignal(
                server.attachmentUrl(dto.Id, mediaSource.Id, att.Index), signal);
            await OPFS().writeBlob(
                S().paths.attachment(server.id, dto.Id, mediaSource.Id, att.Index),
                await res.blob()
            );
            held.push({
                index: att.Index,
                fileName: att.FileName,
                mimeType: att.MimeType,
                codec: att.Codec
            });
        } catch (err) {
            console.warn('[phantom] attachment', att.Index, dto.Id, err.message);
        }
    }
    return held;
}

/**
 * Scrubbing thumbnails, when the source server has generated them.
 *
 * Unverified against a server that actually has them: the QA library has none.
 * Written to fail quietly for that reason rather than to be trusted.
 */
async function downloadTrickplay(server, dto, mediaSource, signal) {
    const byWidth = (dto.Trickplay || {})[mediaSource.Id];
    if (!byWidth) return null;

    const widths = Object.keys(byWidth).map(Number).filter(Number.isFinite);
    if (!widths.length) return null;
    const width = Math.max(...widths);
    const info = byWidth[width];
    if (!info || !info.ThumbnailCount || !info.TileWidth || !info.TileHeight) return null;

    const perTile = info.TileWidth * info.TileHeight;
    const tiles = Math.ceil(info.ThumbnailCount / perTile);
    let stored = 0;
    for (let i = 0; i < tiles; i++) {
        if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
        try {
            const res = await server.fetchSignal(server.trickplayTileUrl(dto.Id, width, i), signal);
            await OPFS().writeBlob(
                S().paths.trickplayTile(server.id, dto.Id, mediaSource.Id, width, i),
                await res.blob()
            );
            stored++;
        } catch (err) {
            console.warn('[phantom] trickplay tile', i, dto.Id, err.message);
            break;
        }
    }
    // All or nothing, and the reason is in the consumer: the video OSD computes
    // which sheet to ask for from the scrub position, the interval and the tile
    // grid, and never reads ThumbnailCount at all
    // (apps/legacy/controllers/playback/video/index.js:1504-1517 in the
    // read-only reference checkout). So there is no descriptor that honestly
    // says "the first half" — a partial set answers the early sheets and 404s
    // every later one, which is scrubbing thumbnails vanishing part way through
    // a film with nothing anywhere to say why. The tile loop breaks on the first
    // failure, so this is the normal shape of a partial set, not a rare one.
    if (stored < tiles) {
        await OPFS().removeDir(S().paths.trickplayDir(server.id, dto.Id, mediaSource.Id, width));
        return null;
    }
    return stored ? Object.assign({ width, tiles: stored }, info) : null;
}

async function setRow(row, changes) {
    const next = Object.assign({}, row, changes, { updatedAt: Date.now() });
    await DB().put('downloads', next);
    return next;
}

/**
 * Pull the original file.
 *
 * Streamed straight to disk rather than buffered: the whole reason media does not
 * live in IndexedDB is that it is too large to materialise.
 */
async function downloadDirect(server, dto, mediaSource, row, onProgress, signal) {
    const container = (mediaSource.Container || 'mp4').toLowerCase();
    const url = `${server.url}/Videos/${dto.Id}/stream.${container}`
        + `?Static=true&mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
    const res = await server.fetchSignal(url, signal);

    const declared = parseInt(res.headers.get('Content-Length') || '', 10);
    const total = Number.isFinite(declared) ? declared : (mediaSource.Size || 0);
    await setRow(row, { bytesTotal: total });

    const path = S().paths.original(server.id, dto.Id, mediaSource.Id, container);
    const written = await OPFS().writeStream(path, res, (bytes) => onProgress(bytes, total));
    return { container, bytes: written };
}

/**
 * Add parameters to a URL the server built for us.
 *
 * Burning a subtitle in is a property of the transcode, so it has to ride on the
 * TranscodingUrl rather than be requested separately; the server hands back a
 * playlist whose segments already have the subtitle in the picture.
 */
/** The transcode parameters for a chosen quality, or none for source quality. */
export function qualityParams(qualityId) {
    const quality = (window.PS_SCHEMA.QUALITIES || []).find((q) => q.id === qualityId);
    if (!quality || !quality.maxHeight) return null;
    return { MaxHeight: quality.maxHeight, VideoBitrate: quality.bitrate };
}

function withParams(url, params) {
    if (!params) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
}

/** The segment URIs out of a variant playlist, resolved against its own URL. */
function segmentUrls(playlist, playlistUrl) {
    return playlist
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => new URL(l, playlistUrl).toString());
}

/**
 * Pull a server-side transcode as a complete VOD stream.
 *
 * Jellyfin's HLS output is EXT-X-PLAYLIST-TYPE:VOD with the whole segment list
 * present up front, so this is an enumeration rather than a recording. Segments
 * are fetched in order on purpose: asking for one out of order makes the server
 * restart ffmpeg at an offset, which is correct and slow.
 */
async function downloadHls(server, dto, mediaSource, row, onProgress, extraParams, signal) {
    const masterUrl = withParams(server.url + mediaSource.TranscodingUrl, extraParams);
    const master = await (await server.fetchSignal(masterUrl, signal)).text();

    // A master playlist points at one variant; a server that answered with the
    // variant directly needs no second hop.
    let variantUrl = masterUrl;
    let variant = master;
    if (master.includes('#EXT-X-STREAM-INF')) {
        const line = master.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        if (!line) throw new Error('master playlist named no variant');
        variantUrl = withParams(new URL(line, masterUrl).toString(), extraParams);
        variant = await (await server.fetchSignal(variantUrl, signal)).text();
    }

    if (!variant.includes('#EXT-X-ENDLIST')) {
        // Without an end list this is a live rendition and the segment list is a
        // window, not the whole asset. Downloading it would silently store a clip.
        throw new Error('transcode is not a complete VOD stream');
    }

    const urls = segmentUrls(variant, variantUrl);
    if (!urls.length) throw new Error('playlist contained no segments');

    await OPFS().writeBlob(S().paths.hlsPlaylist(server.id, dto.Id, mediaSource.Id), new Blob([variant]));

    let bytes = 0;
    for (let i = 0; i < urls.length; i++) {
        if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const res = await server.fetchSignal(urls[i], signal);
        const blob = await res.blob();
        await OPFS().writeBlob(S().paths.hlsSegment(server.id, dto.Id, mediaSource.Id, i), blob);
        bytes += blob.size;
        // Progress is reported against segment count, because the total byte size
        // of a transcode is not known until it has been made.
        onProgress(i + 1, urls.length);
    }
    return { container: 'ts', bytes, segments: urls.length };
}

/**
 * Download one playable item.
 *
 * `options.onProgress(done, total, unit)` is called as it goes; unit is 'bytes'
 * for an original and 'segments' for a transcode.
 *
 * `options.subtitle` is the decision that cannot be revisited later:
 *   {mode:'auto'}            every text track as a switchable sidecar (default)
 *   {mode:'burn', index:N}   track N burned into the picture, forcing a transcode
 *   {mode:'none'}            no subtitles at all
 */
export async function downloadItem(server, reactiveDto, options = {}) {
    const dto = plain(reactiveDto);
    await assertAllowed(server);
    const onProgress = options.onProgress || (() => {});
    const subtitle = options.subtitle || { mode: S().SUBTITLE_MODE.AUTO };

    const info = await server.playbackInfo(dto.Id);
    const mediaSource = pickMediaSource(info.MediaSources || []);
    if (!mediaSource) throw new Error('server offered no media source');

    const tracks = subtitleOptions(mediaSource);
    const audio = audioOptions(mediaSource);

    // A series choice arrives as a description; a single item's arrives as an
    // index, because there was only ever one file to point at.
    let burnTrack = null;
    let subtitleNote = null;
    if (subtitle.mode === S().SUBTITLE_MODE.BURN) {
        if (subtitle.match) {
            burnTrack = matchTrack(tracks, subtitle.match);
            if (!burnTrack) {
                subtitleNote = `no track matching ${subtitle.match.language || 'the chosen one'}`
                    + ` (${subtitle.match.codec || 'unknown codec'}); left without burned-in subtitles`;
            }
        } else if (subtitle.index != null) {
            burnTrack = tracks.find((t) => t.index === subtitle.index) || null;
            if (!burnTrack) subtitleNote = `track ${subtitle.index} is not in this file`;
        }
    }
    const burning = !!burnTrack;

    // A chosen audio track that is not the container's own default can only be
    // delivered by transcoding: the file holds every track, and the browser plays
    // whichever the container says, with no way to switch.
    const chosenAudio = options.audioStreamIndex != null ? Number(options.audioStreamIndex) : null;
    const audioNeedsTranscode = chosenAudio != null
        && !audio.some((a) => a.index === chosenAudio && a.isContainerDefault);

    // Burning is a picture operation, so it can only happen during a transcode.
    const canDirect = !burning && !audioNeedsTranscode
        && (mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream)
        && directPlayable(mediaSource.Container);
    const mode = canDirect ? S().DOWNLOAD_MODE.DIRECT : S().DOWNLOAD_MODE.HLS;
    const plan = hlsPlan(mediaSource, { burning });

    if (!canDirect && !mediaSource.SupportsTranscoding) {
        throw new Error('server can neither stream nor transcode this item');
    }
    // Re-checked now that the mode is known: an original file and an encode are
    // different asks and the server grants them separately.
    if (mode === S().DOWNLOAD_MODE.HLS) await assertAllowed(server, { transcoding: true });

    // Already held: do nothing. Re-running a series download then costs only the
    // episodes that are missing, which is what makes topping one up cheap — and it
    // removes the case where cancelling a re-download destroyed the copy that was
    // already on disk.
    const existing = await DB().get('downloads', [server.id, dto.Id, mediaSource.Id]);
    if (existing && existing.state === S().DOWNLOAD_STATE.COMPLETE && !options.replace) {
        return existing;
    }

    const key = downloadKey(server.id, dto.Id, mediaSource.Id);
    const controller = new AbortController();
    inFlight.set(key, { controller, cancelled: false });

    let row = {
        srv: server.id,
        itemId: dto.Id,
        sourceId: mediaSource.Id,
        state: S().DOWNLOAD_STATE.RUNNING,
        mode,
        container: null,
        bytesTotal: mediaSource.Size || 0,
        bytesDone: 0,
        segments: 0,
        runtimeTicks: dto.RunTimeTicks || mediaSource.RunTimeTicks || 0,
        mediaStreams: mediaSource.MediaStreams || [],
        defaultAudioStreamIndex: mediaSource.DefaultAudioStreamIndex != null ? mediaSource.DefaultAudioStreamIndex : null,
        defaultSubtitleStreamIndex: mediaSource.DefaultSubtitleStreamIndex != null
            ? mediaSource.DefaultSubtitleStreamIndex
            : null,
        audioStreamIndex: chosenAudio,
        bitrate: mediaSource.Bitrate || 0,
        quality: options.quality || S().DEFAULT_QUALITY,
        subtitleMode: subtitle.mode,
        burnedSubtitleIndex: burning ? burnTrack.index : null,
        subtitleNote,
        subtitles: [],
        attachments: [],
        trickplay: null,
        // Never null, and always written. Auto-download does not exist yet, but a
        // nullable origin meeting three-valued logic is how a reaper ends up
        // eligible to delete the things a person asked for.
        origin: 'user',
        error: null,
        name: dto.Name,
        type: dto.Type,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    await DB().put('downloads', row);

    try {
        const transcodeParams = {};
        if (burning) {
            transcodeParams.SubtitleStreamIndex = burnTrack.index;
            transcodeParams.SubtitleMethod = 'Encode';
        } else {
            // -1 is "no subtitles", and saying so is not optional. Leave the index
            // out and the server falls back to the user's own default selection,
            // which for a Japanese audio track is often a picture-based signs and
            // songs track — burned into the video, permanently, without anybody
            // asking. Every burn-in this tool does is one somebody chose.
            transcodeParams.SubtitleStreamIndex = -1;
        }
        if (chosenAudio != null) transcodeParams.AudioStreamIndex = chosenAudio;
        // Only when the picture is being rebuilt anyway. On a stream copy the cap
        // is what creates the re-encode it was meant to bound. See hlsPlan().
        if (!plan.videoCopy) Object.assign(transcodeParams, qualityParams(row.quality) || {});
        const extraParams = Object.keys(transcodeParams).length ? transcodeParams : null;

        const result = mode === S().DOWNLOAD_MODE.DIRECT
            ? await downloadDirect(server, dto, mediaSource, row, (done, total) => {
                onProgress(done, total, 'bytes');
            }, controller.signal)
            : await downloadHls(server, dto, mediaSource, row, (done, total) => {
                onProgress(done, total, 'segments');
            }, extraParams, controller.signal);

        // Sidecars only make sense when nothing was burned in: a burned track is
        // in the picture, and offering it again as a switchable overlay would
        // draw it twice.
        // When a burn-in was asked for and this file had no equivalent track, take
        // the text tracks instead: something readable beats nothing at all.
        const held = burning || subtitle.mode === S().SUBTITLE_MODE.NONE
            ? []
            : await downloadSubtitles(
                server, dto, mediaSource, tracks.filter((t) => t.canExtract), controller.signal);

        // Fonts go with the subtitles that need them, so they are skipped for the
        // same reasons: a burned-in track is already typeset into the picture.
        const attachments = held.length
            ? await downloadAttachments(server, dto, mediaSource, controller.signal)
            : [];
        const trickplay = await downloadTrickplay(server, dto, mediaSource, controller.signal);

        // The stored DTO must describe what is held, not what the source has. It
        // arrives listing every trickplay width the server generated and the
        // downloader keeps exactly one, so advertising the rest lets jellyfin-web
        // ask for tiles that were never stored — every one a 404, with scrubbing
        // thumbnails simply absent and nothing anywhere to say why.
        if (dto.Trickplay) {
            const held = trickplay && ((dto.Trickplay[mediaSource.Id] || {})[trickplay.width]);
            dto.Trickplay = held
                ? { [mediaSource.Id]: { [trickplay.width]: held } }
                : undefined;
        }

        // Before anything is written to `items`, not after. The window between the
        // media transfer and here is not brief — subtitles, font attachments and
        // trickplay tiles all run in it — and none of those loops used to observe
        // a cancel, so pressing Cancel there ended with the item recorded
        // COMPLETE. Behind putItem it would be worse than useless: the library is
        // derived from item rows, so a cancel landing after this line would leave
        // a row for an item with no media and list it as playable.
        if ((inFlight.get(key) || {}).cancelled) {
            throw new DOMException('cancelled', 'AbortError');
        }

        await putItem(server, dto);
        await putImages(server, dto, controller.signal);

        row = await setRow(row, {
            state: S().DOWNLOAD_STATE.COMPLETE,
            container: result.container,
            bytesDone: result.bytes,
            bytesTotal: result.bytes,
            segments: result.segments || 0,
            subtitles: held,
            attachments,
            trickplay
        });
        return row;
    } catch (err) {
        const wasCancelled = (inFlight.get(key) || {}).cancelled || err.name === 'AbortError';
        if (wasCancelled) {
            // A half-written item must not look held: it would play as a truncated
            // file and count against storage with no way to tell why.
            await OPFS().removeDir(S().paths.mediaDir(server.id, dto.Id, mediaSource.Id));
            await DB().del('downloads', [server.id, dto.Id, mediaSource.Id]);
            // The item row and its artwork too, because putItem and putImages may
            // have run before the abort surfaced — putImages is a handful of
            // fetches. The library is derived from item rows, not from download
            // rows, so a row left here lists a cancelled item as playable and
            // nothing ever removes it. Through the sweep rather than by hand:
            // cancelling one source of an item another source still holds must
            // not take the shared row and artwork with it. Play history is not
            // ours to delete, so userdata stays.
            await reclaimUnreachable(server.id);
            const cancelError = new Error('cancelled');
            cancelError.cancelled = true;
            throw cancelError;
        }
        await setRow(row, { state: S().DOWNLOAD_STATE.ERROR, error: String(err.message || err) });
        throw err;
    } finally {
        inFlight.delete(key);
    }
}

/**
 * The subtitle tracks an item offers, without downloading anything.
 *
 * The settings page needs this before it can ask the question, and the answer
 * only exists in a PlaybackInfo response.
 */
export async function inspectSubtitles(server, reactiveDto) {
    const dto = plain(reactiveDto);
    await assertAllowed(server);
    const info = await server.playbackInfo(dto.Id);
    const mediaSource = pickMediaSource(info.MediaSources || []);
    if (!mediaSource) return { tracks: [], audio: [], container: null };
    const canDirect = (mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream)
        && directPlayable(mediaSource.Container);
    const plan = hlsPlan(mediaSource, {});
    const tracks = subtitleOptions(mediaSource);
    const picture = tracks.filter((t) => !t.canExtract);
    const serverDefault = mediaSource.DefaultSubtitleStreamIndex;
    return {
        tracks,
        audio: audioOptions(mediaSource),
        container: mediaSource.Container,
        pictureTracks: picture,
        // What the source server would have done if we said nothing. Worth
        // reporting, because "keep text tracks" reads as "change nothing" and the
        // server's idea of nothing is to burn its own default in.
        serverWouldBurn: !canDirect && picture.some((t) => t.index === serverDefault)
            ? picture.find((t) => t.index === serverDefault)
            : null,
        // Worth saying out loud before the button is pressed: a transcode is work
        // on somebody else's machine, and a series is that work N times over.
        // A remux is not that — the picture is copied — so the two are separate
        // answers and only one of them is a warning.
        willTranscode: !canDirect && !plan.remux,
        willRemux: !canDirect && plan.remux,
        videoCodec: plan.videoCodec,
        videoHeight: plan.height,
        audioCodec: plan.audioCodec,
        // A copied picture with converted sound is still a remux, but saying so
        // is the difference between "nothing happens to this file" and the truth.
        audioWillConvert: !canDirect && plan.remux && !plan.audioCopy
    };
}

/**
 * Download a whole series.
 *
 * The series and season rows are stored even though neither has media, because
 * offline browsing has nobody to ask what an episode belongs to.
 */
export async function downloadSeries(server, reactiveSeriesDto, options = {}) {
    // Cleared before the first await in this function, and it has to stay there.
    // Fetching seasons, episodes and every season's images takes seconds on a
    // large show, the Cancel button is live throughout, and a cancel landing in
    // that window used to set the flag only for a later line to clear it — so the
    // series the user had just cancelled downloaded in full.
    seriesCancelled = false;

    const seriesDto = plain(reactiveSeriesDto);
    await assertAllowed(server);
    const onProgress = options.onProgress || (() => {});

    const [seasons, episodes] = await Promise.all([
        server.seasons(seriesDto.Id),
        server.episodes(seriesDto.Id)
    ]);

    await putItem(server, seriesDto);
    await putImages(server, seriesDto);

    // Season rows are stored for every season, not only the one being downloaded:
    // offline browsing has nobody to ask what an episode belongs to, and a season
    // with nothing in it renders as an empty season rather than as a broken one.
    for (const season of seasons.Items || []) {
        await putItem(server, season);
        await putImages(server, season);
    }

    let list = episodes.Items || [];
    if (options.seasonId) list = list.filter((ep) => ep.SeasonId === options.seasonId);
    if (options.unwatchedOnly) list = list.filter((ep) => !(ep.UserData && ep.UserData.Played));

    const failures = [];
    const notes = [];
    let taken = 0;
    for (let i = 0; i < list.length; i++) {
        // Checked between episodes as well as inside each one: cancelling episode
        // three should not start episode four.
        if (seriesCancelled) break;
        onProgress(i, list.length, 'episodes', list[i].Name);
        try {
            // A per-episode choice, where one was made, beats the series-wide one:
            // it is the answer a person gave about this exact file.
            const override = (options.perEpisode || {})[list[i].Id];
            const subtitle = override
                ? (override.subtitleIndex == null
                    ? { mode: 'auto' }
                    : { mode: 'burn', index: override.subtitleIndex })
                : options.subtitle;
            const audioStreamIndex = override && override.audioIndex != null
                ? override.audioIndex
                : options.audioStreamIndex;

            const row = await downloadItem(server, list[i], {
                subtitle,
                audioStreamIndex,
                quality: options.quality
            });
            if (row && row.subtitleNote) notes.push({ name: list[i].Name, note: row.subtitleNote });
            taken++;
        } catch (err) {
            if (err.cancelled) break;
            // One unplayable episode should not abandon the rest of the series.
            failures.push({ name: list[i].Name, error: String(err.message || err) });
        }
    }
    onProgress(taken, list.length, 'episodes');
    return { episodes: taken, planned: list.length, failures, notes, cancelled: seriesCancelled };
}

/**
 * Do the episodes of this series describe their subtitles the same way?
 *
 * Sampled rather than exhaustive: asking the server for PlaybackInfo on sixty
 * episodes to draw one dialog is not a reasonable thing to do to somebody's
 * server. A few files is enough to tell a consistent show from an inconsistent
 * one, and the per-episode matching handles the rest at download time.
 */
export async function inspectSeriesTracks(server, episodes, sampleSize = 4) {
    const step = Math.max(1, Math.floor(episodes.length / sampleSize));
    const sample = [];
    for (let i = 0; i < episodes.length && sample.length < sampleSize; i += step) sample.push(episodes[i]);

    const seen = [];
    for (const episode of sample) {
        try {
            const info = await server.playbackInfo(episode.Id);
            const ms = pickMediaSource(info.MediaSources || []);
            if (ms) seen.push({ name: episode.Name, tracks: subtitleOptions(ms) });
        } catch {
            // A file that will not describe itself is one the download will report.
        }
    }
    if (seen.length < 2) return { sampled: seen.length, consistent: true, shape: seen[0] ? seen[0].tracks : [] };

    const shape = (tracks) => tracks
        .map((t) => `${t.index}:${t.language}:${t.codec}:${t.isForced ? 'f' : ''}`)
        .join('|');
    const first = shape(seen[0].tracks);
    const consistent = seen.every((e) => shape(e.tracks) === first);
    return { sampled: seen.length, consistent, shape: seen[0].tracks, seen };
}

/* ---------------------------------------------------------------------------
 * Bulk track selection.
 *
 * Ported from jellyfin-mpv-shim's bulk_subtitle.py, weights and all, because it
 * is the same problem and those weights encode real release-group conventions
 * rather than a guess. Two modes plus a manual one:
 *
 *   subbed  original-language audio with the full dialogue subtitles
 *   dubbed  dubbed audio with only the signs and songs track
 *
 * The language pair defaults to Japanese audio and English subtitles, which is
 * the case this exists for; mpv-shim carries the same limitation and says so.
 * ------------------------------------------------------------------------- */

const lower = (v) => String(v == null ? '' : v).toLowerCase();

/** How good a candidate this is for FULL dialogue. Lower is better. */
export function dialogueWeight(text) {
    if (!text) return 900;
    const t = lower(text);
    const hasDialogue = t.includes('main') || t.includes('full') || t.includes('dialogue');
    const hasSongs = t.includes('op/ed') || t.includes('song') || t.includes('lyric');
    const hasSigns = t.includes('sign');
    const vendor = t.includes('bd') || t.includes('retail');
    let weight = 900;
    if (hasDialogue && hasSongs) weight -= 100;
    if (hasSongs) weight += 200;
    if (hasDialogue && hasSigns) weight -= 100;
    else if (hasSigns) weight += 700;
    if (vendor) weight += 50;
    return weight;
}

/** How good a candidate this is for SIGNS AND SONGS. Zero means "not one". */
export function signWeight(text) {
    if (!text) return 0;
    const t = lower(text);
    const hasSongs = t.includes('op/ed') || t.includes('song') || t.includes('lyric');
    const hasSigns = t.includes('sign');
    const vendor = t.includes('bd') || t.includes('retail');
    if (!(hasSongs || hasSigns)) return 0;
    let weight = 900;
    if (hasSongs) weight -= 200;
    if (hasSigns) weight -= 300;
    if (vendor) weight += 50;
    return weight;
}

const isLanguage = (track, code, word) =>
    lower(track.language) === code || lower(track.title).includes(word);

/** Original-language audio plus full dialogue subtitles. */
export function pickSubbed(row, opts = {}) {
    const audioCode = opts.audioLanguage || 'jpn';
    const audioWord = opts.audioWord || 'japan';
    const subCode = opts.subtitleLanguage || 'eng';
    const subWord = opts.subtitleWord || 'english';

    const audio = row.audio.find((a) =>
        isLanguage(a, audioCode, audioWord) && !lower(a.title).includes('commentary'));

    let subtitle = null;
    let best = null;
    for (const track of row.subtitles) {
        if (!isLanguage(track, subCode, subWord)) continue;
        if (track.isForced) continue;
        const weight = dialogueWeight(track.title);
        if (best === null || weight < best) { best = weight; subtitle = track; }
    }
    // Both or neither: a subbed selection with no subtitles is not subbed.
    if (audio && subtitle) return { audioIndex: audio.index, subtitleIndex: subtitle.index };
    return null;
}

/** Dubbed audio plus signs and songs only, which may legitimately be absent. */
export function pickDubbed(row, opts = {}) {
    const code = opts.audioLanguage || 'eng';
    const word = opts.audioWord || 'english';

    const audio = row.audio.find((a) =>
        isLanguage(a, code, word) && !lower(a.title).includes('commentary'));
    if (!audio) return null;

    let subtitle = null;
    let best = null;
    for (const track of row.subtitles) {
        if (!isLanguage(track, code, word)) continue;
        if (track.isForced) { subtitle = track; break; }
        const weight = signWeight(track.title);
        if (weight === 0) continue;
        if (best === null || weight < best) { best = weight; subtitle = track; }
    }
    return { audioIndex: audio.index, subtitleIndex: subtitle ? subtitle.index : null };
}

/**
 * Apply one bulk rule across a set of episodes.
 *
 * Returns a choice per episode and, deliberately, leaves an episode alone when
 * the rule does not fit it: that is the row a person then fixes by hand, and
 * pretending otherwise is how the wrong track gets burned into a whole season.
 */
export function bulkSelect(rows, mode, opts = {}) {
    const out = {};
    const unresolved = [];
    for (const row of rows) {
        let choice = null;
        if (mode === 'subbed') choice = pickSubbed(row, opts);
        else if (mode === 'dubbed') choice = pickDubbed(row, opts);
        else if (mode === 'none') choice = { audioIndex: null, subtitleIndex: null };
        else if (mode === 'track') {
            const nth = row.subtitles[opts.ordinal || 0];
            choice = nth ? { audioIndex: null, subtitleIndex: nth.index } : null;
        } else if (mode === 'language') {
            const hit = row.subtitles.filter((t) => lower(t.language) === lower(opts.language));
            choice = hit.length === 1 ? { audioIndex: null, subtitleIndex: hit[0].index } : null;
        }
        if (choice) out[row.id] = choice;
        else unresolved.push(row.id);
    }
    return { choices: out, unresolved };
}

/**
 * Every episode's tracks, which is what a per-episode grid needs.
 *
 * One PlaybackInfo per episode is a lot to ask of a server, so it is only done
 * when somebody opens the grid, and with a small concurrency and a progress
 * callback rather than sixty requests at once.
 */
export async function inspectEpisodeTracks(server, episodes, onProgress = () => {}, concurrency = 4) {
    const rows = new Array(episodes.length);
    let cursor = 0;
    let done = 0;

    const worker = async () => {
        for (;;) {
            const i = cursor++;
            if (i >= episodes.length) return;
            const episode = episodes[i];
            let subtitles = [];
            let audio = [];
            let container = null;
            try {
                const info = await server.playbackInfo(episode.Id);
                const ms = pickMediaSource(info.MediaSources || []);
                if (ms) {
                    subtitles = subtitleOptions(ms);
                    audio = audioOptions(ms);
                    container = ms.Container;
                }
            } catch (err) {
                console.warn('[phantom] tracks', episode.Name, err.message);
            }
            rows[i] = {
                id: episode.Id,
                name: episode.Name,
                season: episode.ParentIndexNumber,
                index: episode.IndexNumber,
                seasonId: episode.SeasonId,
                subtitles,
                audio,
                container
            };
            onProgress(++done, episodes.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, episodes.length || 1) }, worker));
    return rows.filter(Boolean);
}

/** Seasons and episode counts, for the question asked before a series download. */
export async function inspectSeries(server, reactiveDto) {
    const dto = plain(reactiveDto);
    const [seasons, episodes] = await Promise.all([
        server.seasons(dto.Id),
        server.episodes(dto.Id)
    ]);
    const list = episodes.Items || [];
    const unwatched = list.filter((ep) => !(ep.UserData && ep.UserData.Played));
    return {
        seasons: (seasons.Items || []).map((season) => ({
            id: season.Id,
            name: season.Name,
            indexNumber: season.IndexNumber,
            episodes: list.filter((ep) => ep.SeasonId === season.Id).length,
            unwatched: unwatched.filter((ep) => ep.SeasonId === season.Id).length
        })),
        episodes: list.length,
        unwatched: unwatched.length,
        sample: list[0] || null
    };
}

/**
 * Drop everything on this server that nothing held can still reach.
 *
 * Three lifetimes end in this one place rather than at each call site that
 * removes something, because they are not the same lifetime and every site that
 * guessed got a different subset wrong:
 *
 *   - media and its download row are keyed by media source;
 *   - an item's row and its artwork are keyed by item, so they outlive any one
 *     source and must not go while another source of the same item is held;
 *   - a series' or a season's artwork belongs to NO download row and lives
 *     exactly as long as a held episode names it.
 *
 * Reachability is recomputed rather than decremented, for the reason library.js
 * derives parents at read time: it is then right however a row went away — a
 * failed download, a cancel, a season filter that took nothing — and not only on
 * the path somebody remembered to clean up. Parent ROWS are deliberately left:
 * `loadAll` hides a parent with no held children, and pruning them here would
 * put the same decision in two places.
 *
 * Returns the item ids whose last copy is now gone, so a caller can decide what
 * else belonged to them.
 */
async function reclaimUnreachable(srv) {
    const [downloads, items] = await Promise.all([DB().all('downloads'), DB().all('items')]);
    const held = new Set(downloads.filter((r) => r.srv === srv).map((r) => r.itemId));
    const mine = items.filter((r) => r.srv === srv);

    const reachable = new Set();
    for (const row of mine) {
        if (row.dto.Type !== 'Episode' || !held.has(row.id)) continue;
        if (row.dto.SeasonId) reachable.add(row.dto.SeasonId);
        if (row.dto.SeriesId) reachable.add(row.dto.SeriesId);
    }

    const dropped = new Set();
    for (const row of mine) {
        const isParent = row.dto.Type === 'Series' || row.dto.Type === 'Season';
        if (isParent ? reachable.has(row.id) : held.has(row.id)) continue;
        await OPFS().removeDir(S().paths.imageDir(srv, row.id));
        if (isParent) continue;
        await DB().del('items', [srv, row.id]);
        dropped.add(row.id);
    }
    return dropped;
}

export async function removeDownload(reactiveRow) {
    const row = plain(reactiveRow);
    await OPFS().removeDir(S().paths.mediaDir(row.srv, row.itemId, row.sourceId));
    await DB().del('downloads', [row.srv, row.itemId, row.sourceId]);
    const dropped = await reclaimUnreachable(row.srv);
    // Only when the last copy of the item went. Removing one of two sources is
    // not a decision to forget that it was watched, and a deliberate removal is
    // — which is why this is here and not inside the sweep, where the cancel
    // path would inherit it.
    if (dropped.has(row.itemId)) await DB().del('userdata', [row.srv, row.itemId]);
}

/**
 * What is on disk, grouped the way the download list is drawn.
 *
 * Walked rather than summed from the rows. `bytesDone` records the media
 * transfer and nothing else: subtitles, font attachments, trickplay tiles and
 * artwork are all written without touching it, and a series' or a season's
 * artwork belongs to no download row at all. A figure built from the rows
 * therefore understates the disk by whatever the sidecars weigh however correct
 * deletion is — measured at 24% of the store on the smoke fixture — and
 * SCOPE.md says the figure accounts for every byte on disk.
 *
 * Keys are the path prefixes themselves, so a caller cannot group by a rule that
 * disagrees with where the bytes were written.
 */
export async function storageUsed() {
    const used = { total: 0, byDownload: {}, byItem: {} };
    for (const entry of await OPFS().walk([])) {
        const [root, srv, itemId, sourceId] = entry.path;
        used.total += entry.size;
        if (!srv || !itemId) continue;
        if (root === 'media' && sourceId) {
            const key = srv + '/' + itemId + '/' + sourceId;
            used.byDownload[key] = (used.byDownload[key] || 0) + entry.size;
        } else if (root === 'images') {
            const key = srv + '/' + itemId;
            used.byItem[key] = (used.byItem[key] || 0) + entry.size;
        }
    }
    return used;
}

export async function listDownloads() {
    return DB().all('downloads');
}
