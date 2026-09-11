/* Playback and play state for the phantom server.
 *
 * Playback strategy is decided entirely by the MediaSource this file returns;
 * the player never inspects the bytes. See playbackmanager.js:2884.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;
    const DB = g.PS_DB;
    const OPFS = g.PS_OPFS;
    const { json, noContent, notFound, text, serveFile, mimeFor } = g.PS_HTTP;

    async function findDownload(itemId) {
        const rows = await DB.allByIndex('downloads', 'by_state', S.DOWNLOAD_STATE.COMPLETE);
        return rows.find((r) => r.itemId === itemId) || null;
    }

    async function findItem(itemId) {
        const rows = await DB.all('items');
        return rows.find((r) => r.id === itemId) || null;
    }

    /**
     * Build the MediaSource for a held item.
     *
     * Protocol stays 'File' on purpose in both modes. supportsDirectPlay() only
     * returns true for Protocol 'Http' (playbackmanager.js:618), so 'File' keeps
     * `enableDirectPlay` false, and the client builds a /Videos/{id}/stream URL we
     * can serve ranged instead of trying to open MediaSource.Path, which on a real
     * server is a filesystem path and here would be meaningless.
     */
    function mediaSourceFor(dl, dto, playSessionId) {
        const streams = Array.isArray(dl.mediaStreams) ? dl.mediaStreams : [];
        const base = {
            Protocol: 'File',
            Id: dl.itemId,
            Path: '/phantom/' + dl.srv + '/' + dl.itemId,
            Type: 'Default',
            Name: dto ? dto.Name : 'Offline item',
            IsRemote: false,
            ETag: 'phantom-' + dl.itemId,
            RunTimeTicks: (dto && dto.RunTimeTicks) || dl.runtimeTicks || 0,
            Size: dl.bytesTotal || 0,
            ReadAtNativeFramerate: false,
            IgnoreDts: false,
            IgnoreIndex: false,
            GenPtsInput: false,
            IsInfiniteStream: false,
            RequiresOpening: false,
            RequiresClosing: false,
            RequiresLooping: false,
            SupportsProbing: false,
            VideoType: 'VideoFile',
            // enableHlsJsPlayerForCodecs() dereferences this without a guard, so it
            // must be an array even when we recorded no stream detail.
            MediaStreams: streams,
            MediaAttachments: [],
            Formats: [],
            RequiredHttpHeaders: {},
            DefaultAudioStreamIndex: dl.audioStreamIndex != null
                ? dl.audioStreamIndex
                : (dl.defaultAudioStreamIndex != null ? dl.defaultAudioStreamIndex : null),
            DefaultSubtitleStreamIndex: null,
            Bitrate: dl.bitrate || 0
        };

        // Only offer subtitle tracks we actually hold. A track the player can
        // select and then cannot fetch is worse than one that was never offered,
        // and a burned-in track is in the picture rather than in a list.
        //
        // Codec is reported as the format actually stored, because that is what
        // routes the track: htmlVideoPlayer sends 'ass' and 'ssa' to libass and
        // everything else to a native <track>. Reporting webvtt for an ASS file
        // would hand a styled script to the wrong renderer.
        base.MediaStreams = streams.map((st) => {
            if (st.Type !== 'Subtitle') return st;
            const held = (dl.subtitles || []).find((sub) => sub.index === st.Index);
            if (!held) return null;
            const format = held.format || 'vtt';
            return Object.assign({}, st, {
                Codec: format === 'vtt' ? 'webvtt' : format,
                IsExternal: true,
                IsTextSubtitleStream: true,
                SupportsExternalStream: true,
                DeliveryMethod: 'External',
                DeliveryUrl: `/videos/${dl.itemId}/${dl.sourceId}/Subtitles/${st.Index}/0/Stream.${format}`
            });
        }).filter(Boolean);

        // Fonts an ASS track was authored against. libass reads these from
        // MediaAttachments; without them it substitutes and the typesetting is
        // wrong in ways that are obvious on anime and invisible on plain dialogue.
        // Which track starts selected. The source server's own choice is preferred,
        // but only if we kept that track: pointing at a track we did not download
        // selects nothing and looks like subtitles being off when they are not.
        const heldIndexes = new Set((dl.subtitles || []).map((sub) => sub.index));
        if (dl.defaultSubtitleStreamIndex != null && heldIndexes.has(dl.defaultSubtitleStreamIndex)) {
            base.DefaultSubtitleStreamIndex = dl.defaultSubtitleStreamIndex;
        } else {
            // Default before forced, which is the order the server itself uses:
            // measured against a fixture holding both, Jellyfin selects the
            // default-flagged track and leaves the forced one to be chosen by the
            // audio-language rules we have no way to evaluate here.
            const flagged = base.MediaStreams.find((st) => st.Type === 'Subtitle' && st.IsDefault);
            const forced = base.MediaStreams.find((st) => st.Type === 'Subtitle' && st.IsForced);
            const pick = flagged || forced;
            base.DefaultSubtitleStreamIndex = pick ? pick.Index : null;
        }

        base.MediaAttachments = (dl.attachments || []).map((att) => ({
            Codec: att.codec,
            Index: att.index,
            FileName: att.fileName,
            MimeType: att.mimeType,
            DeliveryUrl: `/videos/${dl.itemId}/${dl.sourceId}/Attachments/${att.index}`
        }));

        if (dl.mode === S.DOWNLOAD_MODE.HLS) {
            return Object.assign(base, {
                Container: 'ts',
                SupportsDirectPlay: false,
                SupportsDirectStream: false,
                SupportsTranscoding: true,
                TranscodingSubProtocol: 'hls',
                TranscodingContainer: 'ts',
                // Points straight at the stored variant playlist. hls.js accepts a
                // media playlist without a master, and we have nothing to choose
                // between: a download is one rendition by definition.
                TranscodingUrl: '/videos/' + dl.itemId + '/main.m3u8'
                    + '?MediaSourceId=' + dl.itemId
                    + '&PlaySessionId=' + playSessionId
            });
        }

        return Object.assign(base, {
            Container: dl.container || 'mp4',
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: false
        });
    }

    const newSessionId = () =>
        Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map((b) => b.toString(16).padStart(2, '0')).join('');

    async function playbackInfo(ctx, itemId) {
        const dl = await findDownload(itemId);
        if (!dl) {
            // A real server answers this way when it cannot build a stream, and
            // jellyfin-web already knows how to show it.
            return json({ MediaSources: [], PlaySessionId: newSessionId(), ErrorCode: 'NoCompatibleStream' });
        }
        const row = await findItem(itemId);
        const playSessionId = newSessionId();
        return json({
            MediaSources: [mediaSourceFor(dl, row && row.dto, playSessionId)],
            PlaySessionId: playSessionId
        });
    }

    // --- media ------------------------------------------------------------

    async function stream(ctx, itemId) {
        const dl = await findDownload(itemId);
        if (!dl || dl.mode !== S.DOWNLOAD_MODE.DIRECT) return notFound('no direct copy of ' + itemId);
        const file = await OPFS.file(S.paths.original(dl.srv, dl.itemId, dl.sourceId, dl.container));
        return serveFile(file, ctx.request, mimeFor(dl.container));
    }

    /**
     * The stored variant playlist, with segment URIs rewritten to point back here.
     *
     * The source server's playlist carries its own query string (api key, codec
     * parameters, a play session that has long since ended); replaying that at the
     * phantom server would be meaningless, and leaving it in makes every segment
     * request a cache miss on a different URL than the one we stored.
     */
    async function hlsPlaylist(ctx, itemId) {
        const dl = await findDownload(itemId);
        if (!dl || dl.mode !== S.DOWNLOAD_MODE.HLS) return notFound('no hls copy of ' + itemId);
        const file = await OPFS.file(S.paths.hlsPlaylist(dl.srv, dl.itemId, dl.sourceId));
        if (!file) return notFound('playlist');

        const body = await file.text();
        let n = 0;
        const rewritten = body.split('\n').map((line) => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return line;
            return '/videos/' + itemId + '/hls1/main/' + (n++) + '.ts';
        }).join('\n');

        return text(rewritten, 'application/vnd.apple.mpegurl', {
            headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store'
            }
        });
    }

    async function hlsSegment(ctx, itemId, index) {
        const dl = await findDownload(itemId);
        if (!dl || dl.mode !== S.DOWNLOAD_MODE.HLS) return notFound('no hls copy of ' + itemId);
        const file = await OPFS.file(S.paths.hlsSegment(dl.srv, dl.itemId, dl.sourceId, index));
        return serveFile(file, ctx.request, 'video/mp2t');
    }

    const SUBTITLE_MIME = {
        vtt: 'text/vtt; charset=utf-8',
        ass: 'text/x-ssa; charset=utf-8',
        ssa: 'text/x-ssa; charset=utf-8',
        srt: 'application/x-subrip; charset=utf-8'
    };

    async function subtitle(ctx, itemId, index) {
        const dl = await findDownload(itemId);
        if (!dl) return notFound('no download for ' + itemId);
        const held = (dl.subtitles || []).find((sub) => sub.index === index);
        const format = (held && held.format) || 'vtt';
        const file = await OPFS.file(S.paths.subtitle(dl.srv, dl.itemId, dl.sourceId, index, format));
        if (!file) return notFound('subtitle ' + index);
        return text(await file.text(), SUBTITLE_MIME[format] || 'text/plain; charset=utf-8');
    }

    async function attachment(ctx, itemId, index) {
        const dl = await findDownload(itemId);
        if (!dl) return notFound('no download for ' + itemId);
        const held = (dl.attachments || []).find((att) => att.index === index);
        const file = await OPFS.file(S.paths.attachment(dl.srv, dl.itemId, dl.sourceId, index));
        return serveFile(file, ctx.request, (held && held.mimeType) || 'application/octet-stream');
    }

    async function trickplayTile(ctx, itemId, width, index) {
        const dl = await findDownload(itemId);
        if (!dl) return notFound('no download for ' + itemId);
        const file = await OPFS.file(S.paths.trickplayTile(dl.srv, dl.itemId, dl.sourceId, width, index));
        return serveFile(file, ctx.request, 'image/jpeg');
    }

    // --- play state -------------------------------------------------------

    async function readBody(request) {
        try {
            const t = await request.clone().text();
            return t ? JSON.parse(t) : {};
        } catch {
            return {};
        }
    }

    async function writeUserData(srv, itemId, changes, setBy) {
        const existing = (await DB.getUserData(srv, itemId)) || {
            srv, itemId, played: false, positionTicks: 0, playCount: 0,
            lastPlayedDate: null, playedSetBy: null, isFavorite: false
        };
        const next = Object.assign({}, existing, changes, {
            playedSetBy: setBy,
            updatedAt: Date.now()
        });
        await DB.put('userdata', next);
        return next;
    }

    /**
     * Progress from our own playback.
     *
     * Advance-only. Reports arrive out of order and a position that went backwards
     * is a stale one, so a lower position is dropped rather than written.
     */
    async function reportProgress(ctx, opts) {
        const body = await readBody(ctx.request);
        const itemId = body.ItemId || body.itemId;
        if (!itemId) return noContent();

        const row = await findItem(itemId);
        if (!row) return noContent();

        const position = Number(body.PositionTicks || 0);
        const existing = await DB.getUserData(row.srv, itemId);
        const changes = {};

        if (!existing || position > (existing.positionTicks || 0)) {
            changes.positionTicks = position;
        }
        if (opts.stopped) {
            const runtime = (row.dto && row.dto.RunTimeTicks) || 0;
            // Same threshold a real server uses to decide a stop near the end means
            // finished rather than abandoned.
            if (runtime && position > runtime * 0.9) {
                changes.played = true;
                changes.positionTicks = 0;
                changes.playCount = ((existing && existing.playCount) || 0) + 1;
                changes.lastPlayedDate = new Date().toISOString();
            }
        }
        if (opts.started) {
            changes.lastPlayedDate = new Date().toISOString();
        }

        if (Object.keys(changes).length) {
            const next = await writeUserData(row.srv, itemId, changes, S.SET_BY.PLAYBACK);
            await DB.journal(opts.stopped ? 'stopped' : (opts.started ? 'started' : 'progress'), row.srv, itemId, {
                positionTicks: next.positionTicks, played: next.played
            });
            await g.PS_NOTIFY.userDataChanged(itemId, next, row.dto);
        }
        return noContent();
    }

    /**
     * A deliberate mark played or unplayed.
     *
     * Written verbatim in both directions, unlike progress. This is the only
     * signal in the app that is authoritative about un-watching, and treating it
     * as a floor leaves an item the user just un-watched watched forever.
     */
    async function setPlayed(ctx, itemId, played) {
        const row = await findItem(itemId);
        if (!row) return notFound('item ' + itemId);
        const existing = await DB.getUserData(row.srv, itemId);
        const next = await writeUserData(row.srv, itemId, {
            played,
            positionTicks: 0,
            playCount: played ? Math.max(1, (existing && existing.playCount) || 0) : 0,
            lastPlayedDate: played ? new Date().toISOString() : null
        }, S.SET_BY.EXPLICIT);
        await DB.journal('played', row.srv, itemId, { played });
        await g.PS_NOTIFY.userDataChanged(itemId, next, row.dto);
        return json(toUserDataDto(next, row.dto));
    }

    async function setFavorite(ctx, itemId, isFavorite) {
        const row = await findItem(itemId);
        if (!row) return notFound('item ' + itemId);
        const next = await writeUserData(row.srv, itemId, { isFavorite }, S.SET_BY.EXPLICIT);
        await DB.journal('favorite', row.srv, itemId, { isFavorite });
        await g.PS_NOTIFY.userDataChanged(itemId, next, row.dto);
        return json(toUserDataDto(next, row.dto));
    }

    function toUserDataDto(ud, dto) {
        return {
            Played: !!ud.played,
            PlaybackPositionTicks: ud.positionTicks || 0,
            PlayCount: ud.playCount || 0,
            IsFavorite: !!ud.isFavorite,
            LastPlayedDate: ud.lastPlayedDate || undefined,
            ItemId: ud.itemId,
            Key: ud.itemId,
            PlayedPercentage: ud.positionTicks && dto && dto.RunTimeTicks
                ? Math.min(100, (ud.positionTicks / dto.RunTimeTicks) * 100)
                : undefined
        };
    }

    g.PS_PLAYBACK = {
        playbackInfo, stream, hlsPlaylist, hlsSegment, subtitle, attachment, trickplayTile,
        reportProgress, setPlayed, setFavorite, toUserDataDto,
        findDownload, findItem
    };
})(self);
