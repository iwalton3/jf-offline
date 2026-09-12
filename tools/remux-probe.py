#!/usr/bin/env python3
"""Measure what a Jellyfin server does to an HLS rendition: copy, or re-encode.

This is the ground truth behind hlsPlan() in overlay/plugin/downloader.js. The
decision cannot be read off PlaybackInfo — SupportsDirectStream is false for
every container the device profile does not list, TranscodeReasons is absent
from the MediaSource entirely (it lives only in the TranscodingUrl query), and
both say "transcode" for a file the server in fact stream-copies.

So it is measured instead: fetch the first segment of the rendition, once as
PlaybackInfo handed it over and once with the download manager's quality cap
added, and probe both with ffprobe.

    python3 tools/remux-probe.py --server http://127.0.0.1:8096 --user qa-user --password stdjflib

What it showed against Jellyfin 12.0.0, with the profile in source.js:

    mkv h264/aac 640x480    as-is  h264 640x480     +720p  h264 640x480   (identical bytes)
    mkv h264/aac 1920x804   as-is  h264 1920x804    +720p  h264 1718x720  (a third of the bytes)
    mkv h264/dts 854x480    as-is  h264 854x480     +720p  h264 854x480   (audio converted, picture copied)
    mkv hevc/aac 1920x1080  as-is  h264 1920x1080   +720p  h264 1280x720  (re-encoded either way)

Read: the cap only ever bites on a source taller than it, and on a source whose
codec the transcoding profile already targets that bite is pure loss — the file
would have arrived untouched.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

# The profile source.js sends, with the codec probes answered the way a desktop
# Chrome answers them. Keep in step with deviceProfile() there.
PROFILE = {
    "MaxStreamingBitrate": 120000000,
    "MaxStaticBitrate": 120000000,
    "DirectPlayProfiles": [
        {"Container": "mp4,m4v", "Type": "Video", "VideoCodec": "h264,hevc",
         "AudioCodec": "aac,mp3,opus,flac"},
        {"Container": "webm", "Type": "Video", "VideoCodec": "vp8,vp9,av1",
         "AudioCodec": "vorbis,opus"},
        {"Container": "mp3", "Type": "Audio"},
        {"Container": "flac", "Type": "Audio"},
    ],
    "TranscodingProfiles": [{
        "Container": "ts", "Type": "Video", "VideoCodec": "h264", "AudioCodec": "aac",
        "Protocol": "hls", "Context": "Streaming", "MaxAudioChannels": "2",
        "MinSegments": 1, "BreakOnNonKeyFrames": True,
    }],
    "ContainerProfiles": [],
    "CodecProfiles": [],
    "SubtitleProfiles": [
        {"Format": "ass", "Method": "External"}, {"Format": "ssa", "Method": "External"},
        {"Format": "vtt", "Method": "External"}, {"Format": "subrip", "Method": "External"},
    ],
}


class Client:
    def __init__(self, base, user, password):
        self.base = base.rstrip('/')
        auth = self._json('/Users/AuthenticateByName',
                          {"Username": user, "Pw": password},
                          headers={'Authorization':
                                   'MediaBrowser Client="remux-probe", Device="cli",'
                                   ' DeviceId="remux-probe", Version="1"'})
        self.token = auth['AccessToken']
        self.user_id = auth['User']['Id']

    def _json(self, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        head = {'Content-Type': 'application/json'}
        head.update(headers or {})
        if getattr(self, 'token', None):
            head['Authorization'] = f'MediaBrowser Token="{self.token}"'
        req = urllib.request.Request(self.base + path, data=data, headers=head)
        return json.load(urllib.request.urlopen(req))

    def get(self, url):
        req = urllib.request.Request(
            url, headers={'Authorization': f'MediaBrowser Token="{self.token}"'})
        return urllib.request.urlopen(req).read()

    def playback_info(self, item_id):
        return self._json(f'/Items/{item_id}/PlaybackInfo',
                          {"UserId": self.user_id, "DeviceProfile": PROFILE,
                           "AutoOpenLiveStream": False})

    def videos(self, limit=400):
        q = urllib.parse.urlencode({
            'Recursive': 'true', 'IncludeItemTypes': 'Movie', 'Fields': 'MediaSources',
            'Limit': limit, 'userId': self.user_id})
        return self._json(f'/Items?{q}').get('Items', [])


def with_params(url, params):
    parts = urllib.parse.urlsplit(url)
    query = dict(urllib.parse.parse_qsl(parts.query))
    query.update(params)
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), ''))


def first_segment(client, item_id, params):
    """The first HLS segment of a rendition, or None if the item direct-plays."""
    source = client.playback_info(item_id)['MediaSources'][0]
    if not source.get('TranscodingUrl'):
        return None
    url = with_params(client.base + source['TranscodingUrl'], params)
    body = client.get(url).decode()
    if '#EXT-X-STREAM-INF' in body:
        line = next(l.strip() for l in body.splitlines() if l.strip() and not l.startswith('#'))
        url = with_params(urllib.parse.urljoin(url, line), params)
        body = client.get(url).decode()
    segment = next(l.strip() for l in body.splitlines() if l.strip() and not l.startswith('#'))
    return client.get(urllib.parse.urljoin(url, segment))


def describe(data):
    with tempfile.NamedTemporaryFile(suffix='.ts', delete=False) as fh:
        fh.write(data)
        path = fh.name
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries',
             'stream=codec_name,width,height,codec_type,channels', '-of', 'json', path],
            capture_output=True, text=True, check=True).stdout
    finally:
        os.unlink(path)
    parts = []
    for stream in json.loads(out)['streams']:
        if stream['codec_type'] == 'video':
            parts.append(f"{stream['codec_name']} {stream.get('width')}x{stream.get('height')}")
        elif stream['codec_type'] == 'audio':
            parts.append(f"{stream['codec_name']} {stream.get('channels')}ch")
    return ', '.join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--server', default='http://127.0.0.1:8096')
    ap.add_argument('--user', default='qa-user')
    ap.add_argument('--password', default='stdjflib')
    ap.add_argument('--max-height', type=int, default=720,
                    help='the cap to compare against, as the manager would send it')
    ap.add_argument('--video-bitrate', type=int, default=3000000)
    ap.add_argument('items', nargs='*',
                    help='item ids; with none, one item per container/codec combination')
    args = ap.parse_args()

    client = Client(args.server, args.user, args.password)

    items = args.items
    if not items:
        by_shape = {}
        for item in client.videos():
            for source in item.get('MediaSources') or []:
                streams = source.get('MediaStreams') or []
                video = next((s for s in streams if s['Type'] == 'Video'), None)
                audio = next((s for s in streams if s['Type'] == 'Audio'), None)
                shape = (source.get('Container'), video and video.get('Codec'),
                         video and video.get('Height'), audio and audio.get('Codec'))
                by_shape.setdefault(shape, item['Id'])
        items = list(by_shape.values())
        print(f'{len(items)} distinct container/codec combinations\n')

    cap = {'MaxHeight': args.max_height, 'VideoBitrate': args.video_bitrate}
    for item_id in items:
        info = client.playback_info(item_id)
        name = info['MediaSources'][0].get('Name') or item_id
        plain = first_segment(client, item_id, {})
        if plain is None:
            print(f'{name[:40]:42} direct play, nothing to measure')
            continue
        capped = first_segment(client, item_id, cap)
        # Identical bytes means the server produced one rendition for both asks,
        # which it only does when it is copying. A difference does not prove the
        # cap caused a re-encode — an hevc source is re-encoded either way — so
        # the source codec beside it is what says which of the two happened.
        unchanged = plain == capped
        source_video = next((s for s in info['MediaSources'][0].get('MediaStreams') or []
                             if s['Type'] == 'Video'), {})
        print(f'{name[:36]:38} from {str(source_video.get("Codec")):6} '
              f'as-is {describe(plain):26} '
              f'+{args.max_height}p {describe(capped):26} '
              f'{"the cap does nothing" if unchanged else "the cap changes the output"}')


if __name__ == '__main__':
    main()
