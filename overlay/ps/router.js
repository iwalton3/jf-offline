/* Route table for the phantom server.
 *
 * The set of endpoints here is what jellyfin-web was observed asking for on the
 * screens v0 covers (tools/probe-requests.js records them against a real server).
 * Everything else in scope answers with a well-formed empty rather than a 404,
 * because an empty list renders and an error does not.
 *
 * Service worker only.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;
    const DB = g.PS_DB;
    const LIB = g.PS_LIBRARY;
    const PB = g.PS_PLAYBACK;
    const PLUGIN = g.PS_PLUGIN;
    const { json, noContent, notFound, text, emptyList, Params } = g.PS_HTTP;

    const HEX32 = '[0-9a-fA-F-]{32,36}';

    // --- identity ---------------------------------------------------------

    const USER_DTO = () => ({
        Name: 'Offline',
        ServerId: S.ID.SERVER,
        Id: S.ID.USER,
        HasPassword: false,
        HasConfiguredPassword: false,
        HasConfiguredEasyPassword: false,
        EnableAutoLogin: true,
        LastLoginDate: new Date().toISOString(),
        LastActivityDate: new Date().toISOString(),
        Configuration: {
            PlayDefaultAudioTrack: true,
            SubtitleLanguagePreference: '',
            DisplayMissingEpisodes: false,
            GroupedFolders: [],
            SubtitleMode: 'Default',
            DisplayCollectionsView: false,
            EnableLocalPassword: false,
            OrderedViews: [],
            LatestItemsExcludes: [],
            MyMediaExcludes: [],
            HidePlayedInLatest: true,
            RememberAudioSelections: true,
            RememberSubtitleSelections: true,
            EnableNextEpisodeAutoPlay: true,
            CastReceiverId: ''
        },
        Policy: {
            // Administrator so the dashboard, and therefore the Offline Sync page,
            // is reachable. There is one user and it is this browser's owner.
            IsAdministrator: true,
            IsHidden: false,
            IsDisabled: false,
            EnableUserPreferenceAccess: true,
            EnableRemoteControlOfOtherUsers: false,
            EnableSharedDeviceControl: false,
            EnableRemoteAccess: true,
            EnableLiveTvManagement: false,
            EnableLiveTvAccess: false,
            EnableMediaPlayback: true,
            EnableAudioPlaybackTranscoding: false,
            EnableVideoPlaybackTranscoding: false,
            EnablePlaybackRemuxing: false,
            EnableContentDeletion: true,
            EnableContentDownloading: true,
            EnableSyncTranscoding: false,
            EnableMediaConversion: false,
            EnableAllDevices: true,
            EnableAllChannels: true,
            EnableAllFolders: true,
            EnablePublicSharing: false,
            BlockedTags: [],
            AccessSchedules: [],
            BlockUnratedItems: [],
            EnabledFolders: [],
            EnabledChannels: [],
            EnabledDevices: [],
            SyncPlayAccess: 'None',
            AuthenticationProviderId: 'phantom',
            PasswordResetProviderId: 'phantom'
        }
    });

    const SYSTEM_INFO_PUBLIC = () => ({
        LocalAddress: self.location.origin,
        ServerName: 'Offline Library',
        Version: '12.0.0',
        ProductName: 'Phantom Jellyfin Server',
        OperatingSystem: '',
        Id: S.ID.SERVER,
        StartupWizardCompleted: true
    });

    async function authenticate() {
        let token = await DB.meta.get('token');
        if (!token) {
            token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
                .map((b) => b.toString(16).padStart(2, '0')).join('');
            await DB.meta.set('token', token);
        }
        return json({
            User: USER_DTO(),
            SessionInfo: {
                Id: S.ID.SERVER,
                UserId: S.ID.USER,
                UserName: 'Offline',
                Client: 'Jellyfin Web',
                DeviceName: 'Browser',
                DeviceId: 'phantom',
                ApplicationVersion: '0.1.0',
                SupportsRemoteControl: false,
                PlayableMediaTypes: ['Video', 'Audio'],
                SupportedCommands: []
            },
            AccessToken: token,
            ServerId: S.ID.SERVER
        });
    }

    // --- display preferences ---------------------------------------------

    async function displayPreferences(ctx, id) {
        if (ctx.request.method === 'POST') {
            const body = await ctx.request.clone().json().catch(() => null);
            if (body) await DB.meta.set('displayprefs:' + id, body);
            return noContent();
        }
        const stored = await DB.meta.get('displayprefs:' + id);
        return json(stored || {
            Id: id,
            ViewType: null,
            SortBy: 'SortName',
            IndexBy: null,
            RememberIndexing: false,
            PrimaryImageHeight: 250,
            PrimaryImageWidth: 250,
            CustomPrefs: {},
            ScrollDirection: 'Horizontal',
            ShowBackdrop: true,
            RememberSorting: false,
            SortOrder: 'Ascending',
            ShowSidebar: false,
            Client: 'emby'
        });
    }

    // --- table ------------------------------------------------------------
    //
    // Ordered: the first match wins, so literal paths must precede the id
    // patterns they would otherwise be captured by (/Items/Latest before
    // /Items/{id}).

    const ROUTES = [
        // identity and chrome
        ['GET', /^\/system\/info\/public$/, () => json(SYSTEM_INFO_PUBLIC())],
        ['GET', /^\/system\/info$/, () => json(Object.assign(SYSTEM_INFO_PUBLIC(), {
            OperatingSystemDisplayName: 'Browser',
            HasPendingRestart: false,
            IsShuttingDown: false,
            SupportsLibraryMonitor: false,
            WebSocketPortNumber: 0,
            CompletedInstallations: [],
            CanSelfRestart: false,
            CanLaunchWebBrowser: false,
            ProgramDataPath: '', WebPath: '', ItemsByNamePath: '', CachePath: '',
            LogPath: '', InternalMetadataPath: '', TranscodingTempPath: '',
            HasUpdateAvailable: false, EncoderLocation: 'System', SystemArchitecture: 'X64'
        }))],
        ['GET', /^\/system\/endpoint$/, () => json({ IsLocal: true, IsInNetwork: true })],
        ['GET', /^\/branding\/configuration$/, () => json({
            LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false
        })],
        ['GET', /^\/branding\/css(\.css)?$/, () => text('', 'text/css')],
        ['GET', /^\/quickconnect\/enabled$/, () => json(false)],
        ['GET', /^\/users\/public$/, () => json([USER_DTO()])],
        ['POST', /^\/users\/authenticatebyname$/, authenticate],
        ['POST', /^\/users\/authenticatewithquickconnect$/, authenticate],
        ['GET', /^\/users\/me$/, () => json(USER_DTO())],
        ['GET', new RegExp('^/users/' + HEX32 + '$'), () => json(USER_DTO())],
        ['GET', /^\/users$/, () => json([USER_DTO()])],
        ['POST', /^\/sessions\/capabilities\/full$/, () => noContent()],
        ['POST', /^\/sessions\/logout$/, () => noContent()],
        ['GET', /^\/sessions$/, () => json([])],
        ['GET', /^\/syncplay\/list$/, () => json([])],
        ['GET', /^\/playback\/bitratetest$/, (ctx) => {
            // Answered with real bytes so the client's own measurement is of
            // something, and capped because nobody benefits from a large local read.
            const size = Math.min(ctx.params.int('size', 500000), 1000000);
            return new Response(new Uint8Array(size), {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }
            });
        }],
        ['GET', /^\/displaypreferences\/([^/]+)$/, displayPreferences],
        ['POST', /^\/displaypreferences\/([^/]+)$/, displayPreferences],

        // library
        ['GET', /^\/userviews$/, LIB.userViews],
        ['GET', /^\/items\/latest$/, LIB.latest],
        ['GET', /^\/items\/filters2?$/, () => json({
            Genres: [], Tags: [], OfficialRatings: [], Years: []
        })],
        ['GET', /^\/items\/counts$/, () => json({
            MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, ArtistCount: 0,
            ProgramCount: 0, TrailerCount: 0, SongCount: 0, AlbumCount: 0,
            MusicVideoCount: 0, BoxSetCount: 0, BookCount: 0, ItemCount: 0
        })],
        ['GET', /^\/items$/, LIB.items],
        ['GET', new RegExp('^/items/(' + HEX32 + ')/images/([a-z]+)(?:/(\\d+))?$', 'i'),
            (ctx, id, type) => LIB.image(ctx, id, type)],
        ['GET', new RegExp('^/items/(' + HEX32 + ')/ancestors$'), (ctx, id) => LIB.ancestors(ctx, id)],
        ['GET', new RegExp('^/items/(' + HEX32 + ')/similar$'), () => emptyList()],
        ['GET', new RegExp('^/items/(' + HEX32 + ')/collections$'), () => emptyList()],
        ['GET', new RegExp('^/items/(' + HEX32 + ')/thememedia$'), () => json({
            ThemeVideosResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
            ThemeSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 }
        })],
        ['POST', new RegExp('^/items/(' + HEX32 + ')/playbackinfo$'), (ctx, id) => PB.playbackInfo(ctx, id)],
        ['GET', new RegExp('^/items/(' + HEX32 + ')/playbackinfo$'), (ctx, id) => PB.playbackInfo(ctx, id)],
        ['GET', new RegExp('^/items/(' + HEX32 + ')$'), (ctx, id) => LIB.itemById(ctx, id)],

        ['GET', /^\/useritems\/resume$/, LIB.resume],
        ['GET', new RegExp('^/users/' + HEX32 + '/items/resume$'), LIB.resume],
        ['GET', new RegExp('^/users/' + HEX32 + '/items/latest$'), LIB.latest],
        ['GET', new RegExp('^/users/' + HEX32 + '/items/(' + HEX32 + ')$'), (ctx, id) => LIB.itemById(ctx, id)],
        ['GET', new RegExp('^/users/' + HEX32 + '/items$'), LIB.items],
        ['GET', new RegExp('^/users/' + HEX32 + '/views$'), LIB.userViews],

        ['GET', /^\/shows\/nextup$/, LIB.nextUp],
        ['GET', /^\/shows\/upcoming$/, () => emptyList()],
        ['GET', new RegExp('^/shows/(' + HEX32 + ')/seasons$'), (ctx, id) => LIB.seasons(ctx, id)],
        ['GET', new RegExp('^/shows/(' + HEX32 + ')/episodes$'), (ctx, id) => LIB.episodes(ctx, id)],

        // In scope but deliberately empty for v0.
        ['GET', /^\/(studios|genres|persons|musicgenres|artists|artists\/albumartists)$/, () => emptyList()],
        ['GET', /^\/search\/hints$/, () => json({ SearchHints: [], TotalRecordCount: 0 })],
        ['GET', /^\/movies\/recommendations$/, () => json([])],
        ['GET', /^\/livetv\/programs(\/recommended)?$/, () => emptyList()],
        ['GET', /^\/livetv\/.*$/, () => emptyList()],

        // playback
        ['GET', new RegExp('^/videos/(' + HEX32 + ')/stream(\\.[a-z0-9]+)?$', 'i'), (ctx, id) => PB.stream(ctx, id)],
        ['GET', new RegExp('^/audio/(' + HEX32 + ')/stream(\\.[a-z0-9]+)?$', 'i'), (ctx, id) => PB.stream(ctx, id)],
        ['GET', new RegExp('^/videos/(' + HEX32 + ')/(?:main|master|live)\\.m3u8$', 'i'), (ctx, id) => PB.hlsPlaylist(ctx, id)],
        ['GET', new RegExp('^/videos/(' + HEX32 + ')/hls1/main/(\\d+)\\.ts$', 'i'),
            (ctx, id, n) => PB.hlsSegment(ctx, id, parseInt(n, 10))],
        // Jellyfin spells this /Videos/{id}/{mediaSourceId}/Subtitles/{index}/{ticks}/Stream.{fmt};
        // the media source is always this item's own here, so it is not captured.
        ['GET', new RegExp('^/videos/(' + HEX32 + ')/' + HEX32 + '/subtitles/(\\d+)/\\d+/stream\\.[a-z]+$', 'i'),
            (ctx, id, index) => PB.subtitle(ctx, id, parseInt(index, 10))],
        ['GET', new RegExp('^/videos/(' + HEX32 + ')/subtitles/(\\d+)/stream\\.[a-z]+$', 'i'),
            (ctx, id, index) => PB.subtitle(ctx, id, parseInt(index, 10))],
        ['GET', new RegExp('^/videos/(' + HEX32 + ')/trickplay/(\\d+)/(\\d+)\\.jpg$', 'i'),
            (ctx, id, width, index) => PB.trickplayTile(ctx, id, width, parseInt(index, 10))],

        // play state
        ['POST', /^\/sessions\/playing$/, (ctx) => PB.reportProgress(ctx, { started: true })],
        ['POST', /^\/sessions\/playing\/progress$/, (ctx) => PB.reportProgress(ctx, {})],
        ['POST', /^\/sessions\/playing\/stopped$/, (ctx) => PB.reportProgress(ctx, { stopped: true })],
        ['POST', /^\/sessions\/playing\/ping$/, () => noContent()],
        ['POST', new RegExp('^/userplayeditems/(' + HEX32 + ')$'), (ctx, id) => PB.setPlayed(ctx, id, true)],
        ['DELETE', new RegExp('^/userplayeditems/(' + HEX32 + ')$'), (ctx, id) => PB.setPlayed(ctx, id, false)],
        ['POST', new RegExp('^/users/' + HEX32 + '/playeditems/(' + HEX32 + ')$'), (ctx, id) => PB.setPlayed(ctx, id, true)],
        ['DELETE', new RegExp('^/users/' + HEX32 + '/playeditems/(' + HEX32 + ')$'), (ctx, id) => PB.setPlayed(ctx, id, false)],
        ['POST', new RegExp('^/userfavoriteitems/(' + HEX32 + ')$'), (ctx, id) => PB.setFavorite(ctx, id, true)],
        ['DELETE', new RegExp('^/userfavoriteitems/(' + HEX32 + ')$'), (ctx, id) => PB.setFavorite(ctx, id, false)],
        ['POST', new RegExp('^/users/' + HEX32 + '/favoriteitems/(' + HEX32 + ')$'), (ctx, id) => PB.setFavorite(ctx, id, true)],
        ['DELETE', new RegExp('^/users/' + HEX32 + '/favoriteitems/(' + HEX32 + ')$'), (ctx, id) => PB.setFavorite(ctx, id, false)],

        // the Offline Sync plugin page
        ['GET', /^\/plugins$/, PLUGIN.plugins],
        ['GET', /^\/web\/configurationpages$/, PLUGIN.configurationPages],
        ['GET', /^\/web\/configurationpage$/, (ctx) => PLUGIN.page(ctx, ctx.params.get('name'))],
        ['GET', /^\/plugins\/securityinfo$/, () => json({ SupporterKey: '', IsMbSupporter: false })]
    ];

    /** Everything the phantom server owns. Anything else is jellyfin-web's own. */
    function handles(pathname) {
        return !pathname.startsWith('/web/') || /^\/web\/configurationpages?$/i.test(pathname);
    }

    async function dispatch(request, url) {
        // Matched lower-cased, because jellyfin-web is not consistent about the
        // case of its paths. Handlers therefore receive LOWER-CASED captures; if a
        // capture's case matters downstream, normalise it where it is used rather
        // than assuming the wire spelling survived this line.
        const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
        const ctx = { request, url, params: new Params(url.searchParams) };

        for (const [method, pattern, handler] of ROUTES) {
            if (method !== request.method) continue;
            const m = pattern.exec(path);
            if (!m) continue;
            try {
                return await handler(ctx, ...m.slice(1));
            } catch (err) {
                console.error('[phantom]', request.method, url.pathname, err);
                return json({ error: String(err && err.message || err) }, { status: 500 });
            }
        }

        console.warn('[phantom] unrouted', request.method, url.pathname + url.search);
        return notFound(request.method + ' ' + url.pathname);
    }

    g.PS_ROUTER = { dispatch, handles, ROUTES };
})(self);
