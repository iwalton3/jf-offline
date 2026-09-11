#!/usr/bin/env python3
"""Dev host for the phantom Jellyfin server proof-of-concept.

Serves jellyfin-web's built output at /web/, with everything in overlay/ shadowing
it. The overlay is therefore a literal diff against an unmodified build: whatever
is in it is what we changed.

Beyond serving files, the host does exactly two things, and both exist because
they have to happen BEFORE the service worker exists:

  1. It answers GET /System/Info/Public with the phantom server's identity.
     jellyfin-web probes for a server during boot and only registers the worker
     afterwards (index.jsx registers from loadPlatformFeatures, after renderApp),
     so on a first visit the probe has nobody to talk to and the app settles on
     "no servers" with nothing to retry it. Measured in Firefox 140: first visit
     logs "Begin connectToServers, with 0 servers", second logs 1 and signs in.

  2. It injects the bootstrap script tags into index.html, so the page that
     installs the worker already has the WebSocket stand-in.

Everything else -- /Items, /Videos, play state -- is answered by the worker in the
browser, and this process never sees it.

A real deployment is still a static host: one JSON file at that path, and two
script tags in index.html.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/css", ".css")

ROOT = os.path.dirname(os.path.abspath(__file__))
OVERLAY = os.path.join(ROOT, "overlay")

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

# Injected ahead of jellyfin-web's own bundle; the same list the worker uses when
# it serves index.html from cache.
BOOTSTRAP_TAGS = "".join(
    f'<script src="{src}"></script>'
    for src in (
        "/web/ps/schema.js",
        "/web/ps/db.js",
        "/web/ps/opfs.js",
        "/web/ps-bootstrap.js",
    )
)


def build_manifest(webroot):
    """Every file the app needs offline, with a version that changes when they do.

    A real deployment generates this at build time. It exists because the app is
    2000-odd lazily-loaded chunks: caching on demand means a route the user has
    not visited yet simply fails in airplane mode, and there is no way to know
    which routes those are until they are needed.

    Source maps are excluded; nothing loads them unless devtools is open.
    """
    files = []
    for base, prefix in ((OVERLAY, ""), (webroot, "")):
        for root, _dirs, names in os.walk(base):
            for name in names:
                if name.endswith(".map"):
                    continue
                full = os.path.join(root, name)
                rel = os.path.relpath(full, base).replace(os.sep, "/")
                files.append((rel, os.path.getsize(full), int(os.path.getmtime(full))))

    # Overlay wins, as it does when serving.
    seen = {}
    for rel, size, mtime in files:
        seen.setdefault(rel, (size, mtime))

    digest = hashlib.sha1()
    for rel in sorted(seen):
        size, mtime = seen[rel]
        digest.update(f"{rel}:{size}:{mtime}\n".encode())

    return {
        "version": digest.hexdigest()[:12],
        "files": ["/web/" + rel for rel in sorted(seen)],
    }


def phantom_server_id():
    """Read the server id out of the schema rather than restating it.

    Two spellings of this id would disagree the first time one changed, and the
    symptom is jellyfin-web storing a server it can then never match against the
    one the worker answers as.
    """
    schema = os.path.join(OVERLAY, "ps", "schema.js")
    with open(schema, encoding="utf-8") as fh:
        m = re.search(r"SERVER:\s*'([0-9a-f]{32})'", fh.read())
    if not m:
        sys.exit(f"could not find the phantom server id in {schema}")
    return m.group(1)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "phantom-dev"

    # --- resolution -------------------------------------------------------

    def resolve(self, path):
        """Map a URL path to a file, overlay first."""
        if path == "/" or path == "":
            return None  # handled as a redirect
        if not path.startswith("/web/"):
            return None
        # jellyfin-web's bundle names contain '@', which the browser sends
        # percent-encoded. Matching the raw path misses every scoped-package chunk,
        # and the app fails to boot with nothing but a 404 to say why.
        rel = unquote(path[len("/web/") :])
        if not rel:
            rel = "index.html"
        # Reject traversal before touching the filesystem.
        if ".." in rel.split("/"):
            return None
        for base in (OVERLAY, self.server.webroot):
            candidate = os.path.normpath(os.path.join(base, rel))
            if not candidate.startswith(base):
                continue
            if os.path.isfile(candidate):
                return candidate
        return None

    # --- responses --------------------------------------------------------

    def send_common(self, ctype, length, extra=None):
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        # The worker registers with jellyfin-web's own register() call, which asks
        # for scope /web/. Sending this anyway costs nothing and keeps the door
        # open if we ever register it ourselves at the root.
        self.send_header("Service-Worker-Allowed", "/")
        self.send_header("Cache-Control", "no-cache")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self, body=True):
        path = self.path.split("?", 1)[0]

        if path == "/web/precache-manifest.json":
            payload = json.dumps(build_manifest(self.server.webroot)).encode()
            self.send_response(200)
            self.send_common("application/json; charset=utf-8", len(payload))
            if body:
                self.wfile.write(payload)
            return

        # The one API response this process owns. See the module docstring.
        if path.lower() == "/system/info/public":
            payload = json.dumps({
                "LocalAddress": f"http://{self.headers.get('Host', '')}",
                "ServerName": "Offline Library",
                "Version": "12.0.0",
                "ProductName": "Phantom Jellyfin Server",
                "OperatingSystem": "",
                "Id": self.server.server_id,
                "StartupWizardCompleted": True,
            }).encode()
            self.send_response(200)
            self.send_common("application/json; charset=utf-8", len(payload))
            if body:
                self.wfile.write(payload)
            return

        if path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        target = self.resolve(path)
        if not target:
            # Anything not under /web/ belongs to the phantom server, which only
            # exists inside the service worker. Reaching this process means the
            # worker is not installed or not controlling the page yet.
            msg = b"phantom server is not installed yet; load /web/ once online\n"
            self.send_response(503)
            self.send_common("text/plain; charset=utf-8", len(msg))
            if body:
                self.wfile.write(msg)
            return

        if os.path.basename(target) == "index.html":
            html = open(target, "rb").read().decode("utf-8")
            marker = html.find("<head>")
            injected = (
                BOOTSTRAP_TAGS + html if marker == -1
                else html[: marker + 6] + BOOTSTRAP_TAGS + html[marker + 6 :]
            ).encode()
            self.send_response(200)
            self.send_common("text/html; charset=utf-8", len(injected))
            if body:
                self.wfile.write(injected)
            return

        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript",
            "application/json",
        ):
            ctype += "; charset=utf-8"

        size = os.path.getsize(target)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200

        if rng:
            m = RANGE_RE.match(rng.strip())
            if m:
                g1, g2 = m.group(1), m.group(2)
                if g1:
                    start = int(g1)
                    end = int(g2) if g2 else size - 1
                elif g2:
                    start = max(0, size - int(g2))
                if start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206

        length = end - start + 1
        self.send_response(status)
        extra = {"Content-Range": f"bytes {start}-{end}/{size}"} if status == 206 else {}
        self.send_common(ctype, length, extra)

        if not body:
            return
        with open(target, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def do_HEAD(self):
        self.do_GET(body=False)

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--webroot",
        default=os.path.expanduser("~/Desktop/jellyfin-web/dist"),
        help="jellyfin-web build output to serve underneath the overlay",
    )
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    webroot = os.path.abspath(os.path.expanduser(args.webroot))
    if not os.path.isfile(os.path.join(webroot, "index.html")):
        sys.exit(f"no jellyfin-web build at {webroot} (run npm run build:production)")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.webroot = webroot
    httpd.verbose = args.verbose
    httpd.server_id = phantom_server_id()
    print(f"overlay  {OVERLAY}")
    print(f"webroot  {webroot}")
    print(f"server   {httpd.server_id}")
    print(f"serving  http://{args.host}:{args.port}/web/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
