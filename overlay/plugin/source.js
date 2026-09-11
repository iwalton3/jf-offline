/* Talking to the user's real Jellyfin servers.
 *
 * Runs in the page, so these requests go straight out cross-origin; the service
 * worker deliberately passes anything not on its own origin through untouched.
 * Jellyfin answers Access-Control-Allow-Origin: * on everything this needs.
 */

/**
 * Servers jellyfin-web is signed in to.
 *
 * Read out of the credential store rather than off a global, because jellyfin-web
 * only ever exposes window.ApiClient (the *current* server) and we need the
 * others. 'jellyfin_credentials' is the key jellyfin-apiclient's Credentials
 * class uses; it is stable API surface for the app, if not a documented one.
 */
export function knownServers(phantomServerId) {
    let creds;
    try {
        creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
    } catch {
        return [];
    }
    return (creds.Servers || [])
        .filter((s) => s.Id !== phantomServerId && s.AccessToken && s.UserId)
        .map((s) => ({
            id: s.Id,
            name: s.Name || s.ManualAddress || s.Id,
            url: (s.ManualAddress || s.LocalAddress || s.RemoteAddress || '').replace(/\/+$/, ''),
            userId: s.UserId,
            token: s.AccessToken
        }))
        .filter((s) => s.url);
}

/**
 * What this browser can play without help.
 *
 * Asked of the browser rather than assumed, because the answer decides whether an
 * item is downloaded as its original file or as a transcode, and that decision
 * cannot be revisited once the bytes are on disk.
 */
export function deviceProfile() {
    const probe = document.createElement('video');
    const can = (type) => probe.canPlayType(type) !== '';

    const DirectPlayProfiles = [];
    if (can('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')) {
        DirectPlayProfiles.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3,opus,flac' });
    }
    if (can('video/mp4; codecs="hvc1.1.6.L93.B0"')) {
        DirectPlayProfiles[0].VideoCodec += ',hevc';
    }
    if (can('video/webm; codecs="vp9,opus"')) {
        DirectPlayProfiles.push({ Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' });
    }
    DirectPlayProfiles.push({ Container: 'mp3', Type: 'Audio' });
    if (can('audio/flac')) DirectPlayProfiles.push({ Container: 'flac', Type: 'Audio' });

    return {
        MaxStreamingBitrate: 120000000,
        MaxStaticBitrate: 120000000,
        DirectPlayProfiles,
        TranscodingProfiles: [{
            Container: 'ts',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac',
            Protocol: 'hls',
            Context: 'Streaming',
            MaxAudioChannels: '2',
            MinSegments: 1,
            BreakOnNonKeyFrames: true
        }],
        ContainerProfiles: [],
        CodecProfiles: [],
        SubtitleProfiles: [
            { Format: 'vtt', Method: 'External' },
            { Format: 'subrip', Method: 'External' }
        ]
    };
}

export class SourceServer {
    constructor(info) {
        Object.assign(this, info);
    }

    get headers() {
        // The token goes in Authorization, not in an api_key query parameter:
        // on 12.0 the query form is refused by /Items/{id}/Download and by the
        // HLS playlist endpoints, which are exactly the ones a download needs.
        return {
            Authorization: `MediaBrowser Client="Offline Sync", Device="Browser", DeviceId="phantom-downloader", Version="0.1.0", Token="${this.token}"`
        };
    }

    async fetch(path, init) {
        const url = path.startsWith('http') ? path : this.url + (path.startsWith('/') ? path : '/' + path);
        const res = await fetch(url, Object.assign({ cache: 'no-store' }, init, {
            headers: Object.assign({}, this.headers, (init && init.headers) || {})
        }));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
        return res;
    }

    async json(path, query) {
        const u = new URL(this.url + (path.startsWith('/') ? path : '/' + path));
        for (const [k, v] of Object.entries(query || {})) {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
        return (await this.fetch(u.toString())).json();
    }

    views() {
        return this.json('/UserViews', { userId: this.userId });
    }

    items(query) {
        return this.json('/Items', Object.assign({
            userId: this.userId,
            Fields: 'Overview,Genres,ProviderIds,MediaSources,ParentId,DateCreated,PremiereDate,People,Studios',
            EnableUserData: true,
            Recursive: true,
            SortBy: 'SortName',
            Limit: 200
        }, query));
    }

    item(id) {
        return this.json(`/Items/${id}`, {
            userId: this.userId,
            Fields: 'Overview,Genres,ProviderIds,MediaSources,ParentId,DateCreated,PremiereDate,People,Studios'
        });
    }

    seasons(seriesId) {
        return this.json(`/Shows/${seriesId}/Seasons`, { userId: this.userId, Fields: 'Overview,ParentId,DateCreated' });
    }

    episodes(seriesId) {
        return this.json(`/Shows/${seriesId}/Episodes`, {
            userId: this.userId,
            Fields: 'Overview,MediaSources,ParentId,DateCreated,PremiereDate'
        });
    }

    async playbackInfo(itemId) {
        const res = await this.fetch(
            `${this.url}/Items/${itemId}/PlaybackInfo?userId=${this.userId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    DeviceProfile: deviceProfile(),
                    EnableDirectPlay: true,
                    EnableDirectStream: true,
                    EnableTranscoding: true,
                    AllowVideoStreamCopy: true,
                    AllowAudioStreamCopy: true,
                    AutoOpenLiveStream: false
                })
            }
        );
        return res.json();
    }

    imageUrl(itemId, type, tag) {
        const u = new URL(`${this.url}/Items/${itemId}/Images/${type}`);
        if (tag) u.searchParams.set('tag', tag);
        u.searchParams.set('maxWidth', type === 'Backdrop' ? '1280' : '600');
        u.searchParams.set('quality', '90');
        return u.toString();
    }
}
