/* Request and response helpers for the phantom server. Service worker only. */
(function (g) {
    'use strict';

    const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

    const json = (body, init) => new Response(JSON.stringify(body), Object.assign(
        { status: 200, headers: JSON_HEADERS }, init || {}
    ));

    const noContent = () => new Response(null, { status: 204 });

    const notFound = (what) => new Response(JSON.stringify({ error: what || 'not found' }), {
        status: 404, headers: JSON_HEADERS
    });

    const text = (body, type, init) => new Response(body, Object.assign({
        status: 200,
        headers: { 'Content-Type': type || 'text/plain; charset=utf-8' }
    }, init || {}));

    /** An empty Jellyfin list result. The shape matters; the emptiness does not. */
    const emptyList = (startIndex) => json({
        Items: [], TotalRecordCount: 0, StartIndex: startIndex || 0
    });

    /**
     * Case-insensitive query parameter access.
     *
     * jellyfin-web is genuinely inconsistent here — the same screen sends both
     * `IncludeItemTypes` and `includeItemTypes`, and `userId` alongside `UserId`.
     * Reading params by exact case is the single easiest way to build a server
     * that works on one screen and mysteriously does not on the next.
     */
    class Params {
        constructor(searchParams) {
            this.map = new Map();
            for (const [k, v] of searchParams) this.map.set(k.toLowerCase(), v);
        }
        get(name, fallback) {
            const v = this.map.get(String(name).toLowerCase());
            return v === undefined || v === '' ? fallback : v;
        }
        int(name, fallback) {
            const v = parseInt(this.get(name), 10);
            return Number.isFinite(v) ? v : fallback;
        }
        bool(name, fallback) {
            const v = this.get(name);
            if (v === undefined) return fallback;
            return String(v).toLowerCase() === 'true';
        }
        /** Comma-separated list, empty array when absent. */
        list(name) {
            const v = this.get(name);
            return v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];
        }
        has(name) {
            return this.map.has(String(name).toLowerCase());
        }
    }

    /**
     * Serve a file from OPFS honouring Range.
     *
     * A media element will not seek in a resource the server answers 200 to, so
     * this must produce a real 206 with Content-Range, including for the
     * open-ended `bytes=0-` a video element opens with.
     */
    async function serveFile(file, request, contentType) {
        if (!file) return notFound('not downloaded');

        const size = file.size;
        const headers = {
            'Content-Type': contentType || file.type || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
        };

        const range = request.headers.get('Range');
        if (!range) {
            return new Response(file, { status: 200, headers: Object.assign({ 'Content-Length': String(size) }, headers) });
        }

        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!m) {
            return new Response(file, { status: 200, headers: Object.assign({ 'Content-Length': String(size) }, headers) });
        }

        let start;
        let end;
        if (m[1] === '') {
            // Suffix range: the last N bytes.
            const suffix = parseInt(m[2], 10);
            if (!Number.isFinite(suffix) || suffix <= 0) {
                return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
            }
            start = Math.max(0, size - suffix);
            end = size - 1;
        } else {
            start = parseInt(m[1], 10);
            end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
        }

        if (!Number.isFinite(start) || start >= size || start < 0) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        end = Math.min(Number.isFinite(end) ? end : size - 1, size - 1);
        if (end < start) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }

        const slice = file.slice(start, end + 1);
        return new Response(slice, {
            status: 206,
            headers: Object.assign({
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${size}`
            }, headers)
        });
    }

    const CONTAINER_MIME = {
        mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
        mov: 'video/quicktime', avi: 'video/x-msvideo', ts: 'video/mp2t',
        mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', opus: 'audio/ogg', ogg: 'audio/ogg'
    };

    const mimeFor = (container) => CONTAINER_MIME[String(container || '').toLowerCase()] || 'application/octet-stream';

    g.PS_HTTP = { json, noContent, notFound, text, emptyList, Params, serveFile, mimeFor };
})(self);
