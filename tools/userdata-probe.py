#!/usr/bin/env python3
"""Measure what a Jellyfin server puts in a UserDataChanged push.

This is the ground truth behind userDataChanged() in overlay/ps/notify.js. The
phantom server has to push the same shape, and the shape cannot be read out of
jellyfin-web: the app only consumes the message, so its source says which fields
it acts on, not which ones arrive or which items they arrive for.

So it is measured instead: open the real server's socket as the user, mark one
episode of a multi-episode series played, and record every frame that follows.

    python3 tools/userdata-probe.py --server http://127.0.0.1:8096 --user qa-user --password stdjflib

What it showed against Jellyfin 12.0.0 is recorded in SCOPE.md, under
"What a UserDataChanged push contains". Re-run it against a new server version
rather than reasoning about it.

The websocket client below is deliberately about eighty lines of RFC 6455
rather than a dependency: it reads server frames, which are never masked, and
sends only the pong and close that keep the connection alive.
"""

import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request

DEVICE_ID = 'userdata-probe'


class Client:
    def __init__(self, base, user, password):
        self.base = base.rstrip('/')
        auth = self._json('/Users/AuthenticateByName',
                          {"Username": user, "Pw": password},
                          headers={'Authorization':
                                   'MediaBrowser Client="userdata-probe", Device="cli",'
                                   f' DeviceId="{DEVICE_ID}", Version="1"'})
        self.token = auth['AccessToken']
        self.user_id = auth['User']['Id']

    def _json(self, path, body=None, headers=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        head = {'Content-Type': 'application/json'}
        head.update(headers or {})
        if getattr(self, 'token', None):
            head['Authorization'] = f'MediaBrowser Token="{self.token}"'
        req = urllib.request.Request(self.base + path, data=data, headers=head,
                                     method=method)
        body = urllib.request.urlopen(req).read()
        return json.loads(body) if body else None

    def query(self, path, **params):
        params = {k: v for k, v in params.items() if v is not None}
        return self._json(f'{path}?{urllib.parse.urlencode(params)}')

    def series_with_episodes(self, minimum=2):
        """A series holding at least `minimum` episodes, with its episode list."""
        series = self.query('/Items', Recursive='true', IncludeItemTypes='Series',
                            userId=self.user_id, Limit=200).get('Items', [])
        for show in series:
            episodes = self.query(f'/Shows/{show["Id"]}/Episodes',
                                  userId=self.user_id,
                                  Fields='SeasonId,SeriesId,ParentId').get('Items', [])
            if len(episodes) >= minimum:
                return show, episodes
        return None, None

    def set_played(self, item_id, played):
        # Jellyfin 12 moved these off the /Users/{id} prefix; the old routes are
        # gone rather than deprecated, so there is no fallback worth writing.
        path = f'/UserPlayedItems/{item_id}'
        return self._json(path, method='POST' if played else 'DELETE',
                          headers={'Content-Length': '0'})


# --- the smallest websocket client that can read a Jellyfin push -------------

class WebSocket:
    def __init__(self, url, headers=None, timeout=10):
        parts = urllib.parse.urlsplit(url)
        port = parts.port or (443 if parts.scheme == 'wss' else 80)
        if parts.scheme == 'wss':
            import ssl
            raw = socket.create_connection((parts.hostname, port), timeout)
            self.sock = ssl.create_default_context().wrap_socket(
                raw, server_hostname=parts.hostname)
        else:
            self.sock = socket.create_connection((parts.hostname, port), timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        target = parts.path + (f'?{parts.query}' if parts.query else '')
        extra = ''.join(f'{k}: {v}\r\n' for k, v in (headers or {}).items())
        self.sock.sendall(
            f'GET {target} HTTP/1.1\r\n'
            f'Host: {parts.hostname}:{port}\r\n'
            'Upgrade: websocket\r\nConnection: Upgrade\r\n'
            f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n'
            f'{extra}\r\n'.encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError('socket closed during handshake')
            self.buf += chunk
        head, _, self.buf = self.buf.partition(b'\r\n\r\n')
        status = head.split(b'\r\n', 1)[0].decode()
        if '101' not in status:
            raise RuntimeError(f'upgrade refused: {status}')

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode, payload=b''):
        # Client frames must be masked; the key may be anything, including zeros,
        # but a real one costs nothing and keeps intermediaries happy.
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 1 << 16:
            header += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            header += bytes([0x80 | 127]) + struct.pack('>Q', n)
        self.sock.sendall(header + mask + masked)

    def send_text(self, text):
        self._send(0x1, text.encode())

    def recv(self, deadline):
        """The next text frame, or None when `deadline` passes."""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.sock.settimeout(remaining)
            try:
                first, second = self._recv_exact(2)
            except (socket.timeout, TimeoutError):
                return None
            opcode = first & 0x0f
            length = second & 0x7f
            if length == 126:
                length = struct.unpack('>H', self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack('>Q', self._recv_exact(8))[0]
            payload = self._recv_exact(length) if length else b''
            if second & 0x80:  # a server frame should never be masked
                raise RuntimeError('server sent a masked frame')
            if opcode == 0x9:
                self._send(0xa, payload)
                continue
            if opcode == 0x8:
                raise ConnectionError('server closed the socket')
            if opcode in (0x1, 0x2):
                return payload.decode('utf-8', 'replace')
            # continuation and pong: nothing here needs them

    def close(self):
        try:
            self._send(0x8, b'\x03\xe8')
        except OSError:
            pass
        self.sock.close()


def collect(ws, seconds, want):
    """Every frame of type `want` seen within `seconds`."""
    deadline = time.monotonic() + seconds
    frames = []
    while True:
        text = ws.recv(deadline)
        if text is None:
            return frames
        try:
            message = json.loads(text)
        except ValueError:
            continue
        if message.get('MessageType') == want:
            frames.append(message)


def describe_entry(client, entry, cache):
    """Label a pushed entry by what the server says the item IS.

    Resolved rather than matched against the episode's own SeasonId/SeriesId: an
    episode's ParentId is its season, so a guessed label cannot tell a season
    push from a series push, and the two are what this probe exists to separate.
    """
    item_id = entry.get('ItemId')
    if item_id not in cache:
        try:
            item = client.query(f'/Items/{item_id}', userId=client.user_id)
            cache[item_id] = f'{item.get("Type")} {item.get("Name", "")[:20]}'
        except Exception:
            cache[item_id] = 'unresolved'
    fields = {k: v for k, v in entry.items() if k not in ('ItemId', 'Key')}
    return f'    {cache[item_id]:<32} {json.dumps(fields, sort_keys=True)}'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--server', default='http://127.0.0.1:8096')
    ap.add_argument('--user', default='qa-user')
    ap.add_argument('--password', default='stdjflib')
    ap.add_argument('--wait', type=float, default=6.0,
                    help='seconds to listen after each change')
    ap.add_argument('--episode', help='episode id; default picks one from a series '
                                      'holding at least two')
    args = ap.parse_args()

    client = Client(args.server, args.user, args.password)

    if args.episode:
        episode = client.query(f'/Items/{args.episode}', userId=client.user_id)
        show = client.query(f'/Items/{episode["SeriesId"]}', userId=client.user_id)
        episodes = [episode]
    else:
        show, episodes = client.series_with_episodes(minimum=2)
        if not show:
            sys.exit('no series with two or more episodes on this server')
        episode = episodes[0]

    labels = {}
    print(f'series {show["Name"]!r} holds {len(episodes)} episode(s) for this user')
    print(f'episode {episode["Name"]!r} {episode["Id"]}')
    print(f'  SeasonId {episode.get("SeasonId")}  SeriesId {episode.get("SeriesId")}'
          f'  ParentId {episode.get("ParentId")}\n')

    # 12.0.0 refuses api_key on the socket, exactly as it does on
    # /Items/{id}/Download and the HLS playlist endpoints. The token has to
    # travel in the header or the upgrade answers 403.
    url = args.server.replace('http', 'ws', 1) + f'/socket?deviceId={DEVICE_ID}'
    ws = WebSocket(url, headers={'Authorization': f'MediaBrowser Token="{client.token}"'})
    try:
        # Drain the greeting (ForceKeepAlive) so it does not land in the capture.
        ws.recv(time.monotonic() + 1.0)

        was_played = bool((episode.get('UserData') or {}).get('Played'))
        for played in (True, False):
            client.set_played(episode['Id'], played)
            frames = collect(ws, args.wait, 'UserDataChanged')
            verb = 'played' if played else 'unplayed'
            print(f'mark {verb}: {len(frames)} UserDataChanged frame(s)')
            for frame in frames:
                entries = frame['Data']['UserDataList']
                print(f'  frame carries {len(entries)} entr(y/ies)')
                for entry in entries:
                    print(describe_entry(client, entry, labels))
            if not frames:
                print('    (nothing pushed)')
            print()
        if was_played:
            client.set_played(episode['Id'], True)
    finally:
        ws.close()


if __name__ == '__main__':
    main()
