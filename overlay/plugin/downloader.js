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
async function downloadDirect(server, dto, mediaSource, row, onProgress) {
    const container = (mediaSource.Container || 'mp4').toLowerCase();
    const url = `${server.url}/Videos/${dto.Id}/stream.${container}`
        + `?Static=true&mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
    const res = await server.fetch(url);

    const declared = parseInt(res.headers.get('Content-Length') || '', 10);
    const total = Number.isFinite(declared) ? declared : (mediaSource.Size || 0);
    await setRow(row, { bytesTotal: total });

    const path = S().paths.original(server.id, dto.Id, mediaSource.Id, container);
    const written = await OPFS().writeStream(path, res, (bytes) => onProgress(bytes, total));
    return { container, bytes: written };
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
async function downloadHls(server, dto, mediaSource, row, onProgress) {
    const masterUrl = server.url + mediaSource.TranscodingUrl;
    const master = await (await server.fetch(masterUrl)).text();

    // A master playlist points at one variant; a server that answered with the
    // variant directly needs no second hop.
    let variantUrl = masterUrl;
    let variant = master;
    if (master.includes('#EXT-X-STREAM-INF')) {
        const line = master.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        if (!line) throw new Error('master playlist named no variant');
        variantUrl = new URL(line, masterUrl).toString();
        variant = await (await server.fetch(variantUrl)).text();
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
        const res = await server.fetch(urls[i]);
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
 * `onProgress(done, total, unit)` is called as it goes; unit is 'bytes' for an
 * original and 'segments' for a transcode.
 */
export async function downloadItem(server, reactiveDto, onProgress = () => {}) {
    const dto = plain(reactiveDto);
    const info = await server.playbackInfo(dto.Id);
    const mediaSource = pickMediaSource(info.MediaSources || []);
    if (!mediaSource) throw new Error('server offered no media source');

    const canDirect = (mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream)
        && directPlayable(mediaSource.Container);
    const mode = canDirect ? S().DOWNLOAD_MODE.DIRECT : S().DOWNLOAD_MODE.HLS;

    if (!canDirect && !mediaSource.SupportsTranscoding) {
        throw new Error('server can neither stream nor transcode this item');
    }

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
        bitrate: mediaSource.Bitrate || 0,
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
        const result = mode === S().DOWNLOAD_MODE.DIRECT
            ? await downloadDirect(server, dto, mediaSource, row, (done, total) => {
                onProgress(done, total, 'bytes');
            })
            : await downloadHls(server, dto, mediaSource, row, (done, total) => {
                onProgress(done, total, 'segments');
            });

        await putItem(server, dto);
        await putImages(server, dto);

        row = await setRow(row, {
            state: S().DOWNLOAD_STATE.COMPLETE,
            container: result.container,
            bytesDone: result.bytes,
            bytesTotal: result.bytes,
            segments: result.segments || 0
        });
        return row;
    } catch (err) {
        await setRow(row, { state: S().DOWNLOAD_STATE.ERROR, error: String(err.message || err) });
        throw err;
    }
}

/**
 * Download a whole series.
 *
 * The series and season rows are stored even though neither has media, because
 * offline browsing has nobody to ask what an episode belongs to.
 */
export async function downloadSeries(server, reactiveSeriesDto, onProgress = () => {}) {
    const seriesDto = plain(reactiveSeriesDto);
    const [seasons, episodes] = await Promise.all([
        server.seasons(seriesDto.Id),
        server.episodes(seriesDto.Id)
    ]);

    await putItem(server, seriesDto);
    await putImages(server, seriesDto);
    for (const season of seasons.Items || []) {
        await putItem(server, season);
        await putImages(server, season);
    }

    const list = episodes.Items || [];
    const failures = [];
    for (let i = 0; i < list.length; i++) {
        onProgress(i, list.length, 'episodes', list[i].Name);
        try {
            await downloadItem(server, list[i]);
        } catch (err) {
            // One unplayable episode should not abandon the rest of the series.
            failures.push({ name: list[i].Name, error: String(err.message || err) });
        }
    }
    onProgress(list.length, list.length, 'episodes');
    return { episodes: list.length, failures };
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
