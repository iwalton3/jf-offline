/* The download engine.
 *
 * Runs in the page, not in the service worker. A service worker is killed after a
 * short idle period, so a download loop living in one dies part-way through a
 * file; the page stays alive as long as it is open. The cost is that downloads
 * need this page open, which is the v0 trade. Background Fetch is the way out and
 * is Chrome-only, which is no longer a constraint here.
 */

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

/** Containers this browser can hand to a <video> element without a transcode. */
function directPlayable(container) {
    const c = String(container || '').toLowerCase();
    return c === 'mp4' || c === 'm4v' || c === 'webm' || c === 'mov';
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

async function putImages(server, dto) {
    const wanted = [['Primary', dto.ImageTags && dto.ImageTags.Primary]];
    if (dto.ImageTags && dto.ImageTags.Thumb) wanted.push(['Thumb', dto.ImageTags.Thumb]);
    if (dto.ImageTags && dto.ImageTags.Logo) wanted.push(['Logo', dto.ImageTags.Logo]);
    if (dto.BackdropImageTags && dto.BackdropImageTags.length) wanted.push(['Backdrop', dto.BackdropImageTags[0]]);

    for (const [type, tag] of wanted) {
        if (!tag) continue;
        try {
            const res = await server.fetch(server.imageUrl(dto.Id, type, tag));
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

async function downloadSubtitles(server, dto, mediaSource, tracks) {
    const held = [];
    for (const track of tracks) {
        const format = subtitleFormat(track.codec);
        try {
            const res = await server.fetch(server.subtitleUrl(dto.Id, mediaSource.Id, track.index, format));
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
async function downloadAttachments(server, dto, mediaSource) {
    const wanted = (mediaSource.MediaAttachments || [])
        .filter((att) => FONT_MIME_TYPES.includes(att.MimeType));

    const held = [];
    for (const att of wanted) {
        try {
            const res = await server.fetch(server.attachmentUrl(dto.Id, mediaSource.Id, att.Index));
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
async function downloadTrickplay(server, dto, mediaSource) {
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
        try {
            const res = await server.fetch(server.trickplayTileUrl(dto.Id, width, i));
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
    const onProgress = options.onProgress || (() => {});
    const subtitle = options.subtitle || { mode: S().SUBTITLE_MODE.AUTO };

    const info = await server.playbackInfo(dto.Id);
    const mediaSource = pickMediaSource(info.MediaSources || []);
    if (!mediaSource) throw new Error('server offered no media source');

    const tracks = subtitleOptions(mediaSource);
    const audio = audioOptions(mediaSource);
    const burning = subtitle.mode === S().SUBTITLE_MODE.BURN && subtitle.index != null;

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

    if (!canDirect && !mediaSource.SupportsTranscoding) {
        throw new Error('server can neither stream nor transcode this item');
    }

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
        burnedSubtitleIndex: burning ? subtitle.index : null,
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
            transcodeParams.SubtitleStreamIndex = subtitle.index;
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
        Object.assign(transcodeParams, qualityParams(row.quality) || {});
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
        const held = burning || subtitle.mode === S().SUBTITLE_MODE.NONE
            ? []
            : await downloadSubtitles(server, dto, mediaSource, tracks.filter((t) => t.canExtract));

        // Fonts go with the subtitles that need them, so they are skipped for the
        // same reasons: a burned-in track is already typeset into the picture.
        const attachments = held.length ? await downloadAttachments(server, dto, mediaSource) : [];
        const trickplay = await downloadTrickplay(server, dto, mediaSource);

        await putItem(server, dto);
        await putImages(server, dto);

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
    const info = await server.playbackInfo(dto.Id);
    const mediaSource = pickMediaSource(info.MediaSources || []);
    if (!mediaSource) return { tracks: [], audio: [], container: null };
    const canDirect = (mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream)
        && directPlayable(mediaSource.Container);
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
        willTranscode: !canDirect,
        reasons: mediaSource.TranscodeReasons || null
    };
}

/**
 * Download a whole series.
 *
 * The series and season rows are stored even though neither has media, because
 * offline browsing has nobody to ask what an episode belongs to.
 */
export async function downloadSeries(server, reactiveSeriesDto, options = {}) {
    const seriesDto = plain(reactiveSeriesDto);
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

    seriesCancelled = false;
    const failures = [];
    let taken = 0;
    for (let i = 0; i < list.length; i++) {
        // Checked between episodes as well as inside each one: cancelling episode
        // three should not start episode four.
        if (seriesCancelled) break;
        onProgress(i, list.length, 'episodes', list[i].Name);
        try {
            await downloadItem(server, list[i], {
                subtitle: options.subtitle,
                audioStreamIndex: options.audioStreamIndex,
                quality: options.quality
            });
            taken++;
        } catch (err) {
            if (err.cancelled) break;
            // One unplayable episode should not abandon the rest of the series.
            failures.push({ name: list[i].Name, error: String(err.message || err) });
        }
    }
    onProgress(taken, list.length, 'episodes');
    return { episodes: taken, planned: list.length, failures, cancelled: seriesCancelled };
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

export async function removeDownload(reactiveRow) {
    const row = plain(reactiveRow);
    await OPFS().removeDir(S().paths.mediaDir(row.srv, row.itemId, row.sourceId));
    await DB().del('downloads', [row.srv, row.itemId, row.sourceId]);
    await DB().del('items', [row.srv, row.itemId]);
    await DB().del('userdata', [row.srv, row.itemId]);
}

export async function listDownloads() {
    return DB().all('downloads');
}
